#!/usr/bin/env python3
"""Run a SERIES of live iOS Network Wars games with the pure C-UCT engine and
log a rich JSONL: full per-move trajectory + the search's win expectation per
move + the exact algorithm configuration that produced it.

Reuses play.py's phone-driver primitives (capture/parse/tap/settle). Adds:
  - per-game play loop -> terminal (win / loss), winner detection
  - per-move logging: board before, chosen attack, winexp (RED win-prob the MCTS
    assigns the move), visit count, counts before/after
  - automatic restart between games via the post-game modal (NEVER surrenders —
    every game is played to its natural terminal; partial games are kept, not forfeit)
  - running win tally + JSONL (one record per game, plus a leading meta record)

The phone is the bottleneck; search is sub-second/move. The mirror link drops if
the physical phone is touched ("iPhone in Use") — the driver pauses and re-polls
rather than crashing, and logs every game-over modal's raw OCR so no result is
lost even if auto-classification is unsure.

Usage:
  python series.py --games 100 --sims 8000 [--out runs/series_b8k.jsonl]
                   [--max-rounds 45] [--max-attacks 14]
"""
import argparse
import json
import os
import subprocess
import time
import urllib.request

import play as PL   # reuse the proven phone-driver primitives

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, 'runs')
os.makedirs(RUNS, exist_ok=True)

DASH_PORT = 8778
DASH_URL = f'http://127.0.0.1:{DASH_PORT}'


def start_dashboard():
    """Launch the publish-based dashboard server; return (proc, url) or (None, None)."""
    proc = subprocess.Popen([PL.PYTHON, os.path.join(HERE, 'dashserver.py'),
                             '--port', str(DASH_PORT)])
    for _ in range(40):
        try:
            if urllib.request.urlopen(DASH_URL + '/healthz', timeout=1).read() == b'ok':
                return proc, DASH_URL
        except Exception:
            time.sleep(0.25)
    return proc, DASH_URL   # serve anyway; dashboard just polls


def _post(path, payload):
    """Best-effort POST to the dashboard; never let telemetry break the run."""
    try:
        req = urllib.request.Request(DASH_URL + path,
                                     data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass


def stage(name):
    """Report the driver's current activity to the dashboard (with a server-side
    timestamp) so a stall shows up as a growing elapsed timer."""
    _post('/stage', {'stage': name})


def publish_move(st, mv, turn, shot=None):
    """Push the current board + the search's decision to the dashboard.
    `shot` is the screenshot filename the parsed board came from, so the dashboard
    can show it side-by-side (eyeball stale-frame vs bad-OCR)."""
    chosen = None if mv.get('action') == 'stop' else {'from': mv.get('from'), 'to': mv.get('to')}
    _post('/publish', {
        'board': {'grid': st['grid'], 'nodes': st['nodes']},
        'counts': st['counts'], 'value': mv.get('winexp'),
        'chosen': chosen, 'chosen_end': mv.get('action') == 'stop',
        'top': mv.get('top', []), 'total_visits': mv.get('visits', 0),
        'phase': 'end-turn' if mv.get('action') == 'stop' else 'attack',
        'turn': turn, 'shot': shot,
    })

# UI coords (logical = capture px / 2), mapped live 2026-06-20 via ocr
NEW_GAME = (242, 418)        # New Game button position (shared by the post-game modal)
WIN_NODES = PL.WIN_NODES     # 24
# Policy: NEVER surrender — play every game to its natural terminal (win/loss) and
# restart only via the post-game modal. See repo CLAUDE.md.


def now():
    return time.time()


def counts_winner(counts):
    """Return faction at >= WIN_NODES, else None."""
    for f, c in counts.items():
        if c >= WIN_NODES:
            return f
    return None


def classify_over(path, last_counts):
    """Best-effort win/loss from the game-over modal: OCR keywords first, then the
    last parsed counts. Returns (result, winner, raw_ocr)."""
    raw = PL.sh(PL.OCR, path).stdout
    low = raw.lower()
    result, winner = 'unknown', None
    if 'you won' in low or 'you win' in low or 'victory' in low:
        result, winner = 'win', 'red'
    elif 'you lost' in low or 'you lose' in low or 'defeat' in low:
        result, winner = 'loss', None
    if result == 'unknown' and last_counts:
        w = counts_winner(last_counts) or max(last_counts, key=last_counts.get)
        if last_counts.get(w, 0) >= 20:
            winner = w
            result = 'win' if w == 'red' else 'loss'
    return result, winner, raw.strip()


def find_button(path, words):
    """OCR-locate a button whose text contains any of `words`; logical (x,y) or None."""
    out = PL.sh(PL.OCR, path).stdout
    for line in out.splitlines():
        parts = line.split('\t')
        if len(parts) != 3:
            continue
        txt, cx, cy = parts[0].lower(), parts[1], parts[2]
        if any(w in txt for w in words):
            try:
                return (round(float(cx) / 2), round(float(cy) / 2))
            except ValueError:
                continue
    return None


def wait_connected(tag='reconnect', timeout=1800):
    """Poll until the phone shows a parseable board again (mirror link restored)."""
    t0 = now()
    while now() - t0 < timeout:
        PL.place()
        path = PL.shot(f'{tag}.png')
        if not os.path.exists(path):       # screencapture failed (window gone)
            time.sleep(10); continue
        st = PL.P.parse(path)
        if sum(st['counts'].values()) >= 12:
            return True
        stage('⚠ mirror link DOWN — lock the phone to reconnect')
        print('   …mirror link down ("iPhone in Use"?) — lock the phone to reconnect; retrying')
        time.sleep(10)
    return False


PLAY_AGAIN_YES = (221, 418)   # "Play again?" modal -> Yes button, LOGICAL=px/2 (mapped 2026-06-20)


def restart_game():
    """Move to the next playable game. NEVER surrenders. The post-game modal is
    'You Lost!/Won! — Play again?  No / Yes' -> tap YES. But a game often bails
    'unknown' on a transient glitch while it's actually STILL LIVE — in that case
    there's no modal, so just return the live board and keep playing it (this is
    what kept killing the run). Returns a playable state, or None if truly stuck."""
    for attempt in range(6):
        stage(f'restarting — next game (attempt {attempt + 1})')
        path = PL.shot('restart_probe.png')
        ocr = PL.sh(PL.OCR, path).stdout.lower()
        if 'play again' in ocr or 'you lost' in ocr or 'you won' in ocr:
            btn = find_button(path, ('yes',)) or PLAY_AGAIN_YES   # tap YES, not the prompt
            print(f'   restart: post-game modal -> tapping {btn}')
            PL.tap(*btn)
            time.sleep(2.5)
            st, fp = PL.capture_state('restart_check')
            if fp is not None and sum(st['counts'].values()) == 30:
                return st
        else:
            btn = find_button(path, ('new game', 'rematch', 'replay'))
            if btn is not None:
                print(f'   restart: tapping {btn}')
                PL.tap(*btn); time.sleep(2.5)
                st, fp = PL.capture_state('restart_check')
                if fp is not None and sum(st['counts'].values()) == 30:
                    return st
            else:
                # NO modal -> the 'unknown' was a false bail; the game is still live.
                # deselect any stale highlight and resume play on the live board.
                for ex, ey in ((12, 380), (306, 380)):
                    PL.tap(ex, ey); time.sleep(0.2)
                st, fp = PL.capture_state('restart_live')
                if fp is not None and sum(st['counts'].values()) == 30:
                    print('   restart: no modal — game still live, resuming play')
                    return st
                if 'connect' in ocr or 'iphone in use' in ocr:
                    print('   restart: mirror link down; waiting to reconnect')
                    wait_connected('restart_recon', timeout=600)
        print(f'   restart attempt {attempt}: no playable board yet; retrying')
        time.sleep(2)
    return None


def play_one_game(args, gi):
    """Play a single game to terminal. Returns a trajectory record dict."""
    rec = {
        'game_index': gi, 'started_at': now(), 'result': 'unknown',
        'winner': None, 'rounds': 0, 'red_final': None, 'trajectory': [],
        'note': None,
    }
    PL.place()
    # clear any stale selection left by an interrupted game (a lingering highlight
    # makes the parser recover/mis-color nodes -> count mismatch -> stuck start).
    # full tap() (re-activates IM) on empty margins, where tap_fast silently misses.
    for ex, ey in ((12, 380), (306, 380), (12, 380)):
        PL.tap(ex, ey); time.sleep(0.2)
    stage(f'capturing start board (game {gi + 1})')
    st, fp = PL.capture_state(f'g{gi}_r0')
    if st == 'over' or fp is None:
        if not wait_connected(f'g{gi}_wait'):
            rec['note'] = 'no board / link down at game start'
            rec['ended_at'] = now()
            return rec
        st, fp = PL.capture_state(f'g{gi}_r0')
        if fp is None:
            rec['note'] = 'could not stabilize start board'
            rec['ended_at'] = now()
            return rec

    last_counts = dict(st['counts'])
    cur_shot = f'g{gi}_r0.png'        # screenshot the current `st` was parsed from
    for rnd in range(args.max_rounds):
        rec['rounds'] = rnd + 1
        # winner check at top of round (a bot may have won during its turn)
        w = counts_winner(st['counts'])
        if w is not None:
            rec['result'] = 'win' if w == 'red' else 'loss'
            rec['winner'] = w
            break
        if st['counts'].get('red', 0) == 0:
            rec['result'] = 'loss'; rec['winner'] = None; rec['note'] = 'red eliminated'
            break

        turn = {'round': rnd, 'counts_before': dict(st['counts']),
                'board_before': [
                    {'id': n['id'], 'r': n['row'], 'c': n['col'],
                     'o': n['owner'], 's': n['strength']} for n in st['nodes']],
                'moves': []}
        last_counts = dict(st['counts'])

        misses = 0
        over_mid = False
        for a in range(args.max_attacks):
            stage(f'searching · game {gi + 1} round {rnd + 1} move {a + 1}')
            mv = PL.mcts_move(st, args.rollout, engine='fast', sims=args.sims,
                              turns=rnd + 1, wset=args.wset, c_puct=args.c_puct,
                              nroll=args.nroll)
            publish_move(st, mv, rnd + 1, shot=cur_shot)
            if mv.get('action') == 'stop':
                turn['moves'].append({'action': 'stop', 'winexp': mv.get('winexp'),
                                      'visits': mv.get('visits')})
                break
            fx, fy = mv['fromPx']; tx, ty = mv['toPx']
            cb = dict(st['counts'])
            # full tap() re-activates iPhone Mirroring each time — taps land reliably
            # even after focus changes (tap_fast missed and froze the board mid-series)
            PL.tap(round(fx / 2), round(fy / 2)); time.sleep(0.3)
            PL.tap(round(tx / 2), round(ty / 2)); time.sleep(0.4)
            stage(f'reading board after attack · game {gi + 1} round {rnd + 1}')
            st2, fp2 = PL.capture_state(f'g{gi}_r{rnd}_a{a}')
            move_rec = {'from': mv['from'], 'to': mv['to'],
                        'winexp': mv.get('winexp'),
                        'visits': mv.get('visits'), 'moveVisits': mv.get('moveVisits'),
                        'counts_before': cb}
            if st2 == 'over':
                move_rec['result'] = 'game_over_modal'
                turn['moves'].append(move_rec)
                over_mid = True
                break
            if fp2 is None:
                move_rec['result'] = 'parse_invalid'
                turn['moves'].append(move_rec)
                break
            if fp2 == fp:
                misses += 1
                move_rec['result'] = f'no_change_miss{misses}'
                turn['moves'].append(move_rec)
                PL.place()
                if misses >= 2:
                    break
                continue
            misses = 0
            move_rec['counts_after'] = dict(st2['counts'])
            # full post-attack board (with strengths) so each red tap is a single,
            # ground-truth battle observation: chaining board_before -> board_after
            # gives (attacker a, defender d, outcome, SURVIVOR strengths) for fitting
            # the real iOS battle function. See iphone_data/extract_battles.py.
            move_rec['board_after'] = [
                {'id': n['id'], 'r': n['row'], 'c': n['col'],
                 'o': n['owner'], 's': n['strength']} for n in st2['nodes']]
            move_rec['result'] = 'applied'
            turn['moves'].append(move_rec)
            st, fp = st2, fp2
            cur_shot = f'g{gi}_r{rnd}_a{a}.png'
            last_counts = dict(st['counts'])
            if counts_winner(st['counts']) == 'red':
                break
        turn['counts_after'] = dict(st['counts'])
        rec['trajectory'].append(turn)

        if over_mid:
            break
        w = counts_winner(st['counts'])
        if w is not None:
            rec['result'] = 'win' if w == 'red' else 'loss'; rec['winner'] = w
            break

        # End turn -> bots play (full tap re-activates IM so the tap lands)
        PL.tap(*PL.END_TURN)
        time.sleep(1.2)
        stage(f'bots playing — waiting · game {gi + 1} round {rnd + 1}')
        st3, fp3 = PL.capture_state(f'g{gi}_r{rnd}_end', max_tries=45)  # bots animate longer
        if st3 == 'over':
            over_mid = True
            break
        # transient post-bot parse glitches are common — re-place + recapture a few
        # times (and ride out a brief link drop) before giving up on the game.
        tries = 0
        while fp3 is None and tries < 4:
            tries += 1
            if not wait_connected(f'g{gi}_r{rnd}_recover{tries}', timeout=300):
                break
            PL.place(); time.sleep(0.6)
            st3, fp3 = PL.capture_state(f'g{gi}_r{rnd}_end{tries}', max_tries=45)
            if st3 == 'over':
                over_mid = True
                break
        if over_mid:
            break
        if fp3 is None:
            rec['note'] = 'could not stabilize after bots (retries exhausted)'; break
        st, fp = st3, fp3
        cur_shot = f'g{gi}_r{rnd}_end{tries}.png' if tries else f'g{gi}_r{rnd}_end.png'
        last_counts = dict(st['counts'])

    # if we ended on a modal, classify from it
    if rec['result'] == 'unknown':
        over_path = PL.shot(f'g{gi}_over.png')
        if PL.is_game_over(over_path):
            res, win, raw = classify_over(over_path, last_counts)
            rec['result'], rec['winner'] = res, win
            rec['over_ocr'] = raw
        elif rec['rounds'] >= args.max_rounds:
            rec['note'] = 'hit max-rounds without terminal'

    rec['red_final'] = last_counts.get('red')
    rec['ended_at'] = now()
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=100)
    ap.add_argument('--sims', type=int, default=16000)   # ~0.56s/move; ~80% target
    ap.add_argument('--wset', default='C1')
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--rollout', default='strong')   # unused by fast engine; kept for mcts_move sig
    ap.add_argument('--max-rounds', type=int, default=80,   # high: let games finish naturally
                    help='hard cap only; games are expected to reach a natural win/loss')
    ap.add_argument('--max-attacks', type=int, default=14)
    ap.add_argument('--out', default=os.path.join(RUNS, 'series_b8k.jsonl'))
    ap.add_argument('--start-index', type=int, default=0)
    args = ap.parse_args()

    import sys
    sys.path.insert(0, os.path.dirname(HERE))
    from fmcts import WSETS
    config = {
        'engine': 'fast_c_uct', 'neural_net': False, 'sims': args.sims,
        'wset': args.wset, 'ranked_weights': WSETS[args.wset],
        'c_puct': args.c_puct, 'nroll': args.nroll, 'priors': 'uniform',
        'rollout_policy': 'ranked_C1', 'win_nodes': WIN_NODES,
        'max_rounds': args.max_rounds, 'max_attacks': args.max_attacks,
        'engine_build': 'fast_engine.so (-O3 -ffast-math)', 'role': 'red',
        'winexp_def': 'backed-up Q of the chosen root child = RED win-prob estimate',
        'seed_exploitation': False, 'never_surrender': True,
    }

    print(f'=== SERIES: {args.games} games, pure C-UCT sims={args.sims} '
          f'wset={args.wset} c_puct={args.c_puct} ===')
    print(f'logging -> {args.out}')
    dash_proc, dash_url = start_dashboard()
    print(f'*** live dashboard: {dash_url} ***', flush=True)
    PL.place()

    wins = losses = unknown = 0
    try:
      with open(args.out, 'a', buffering=1) as fout:
        if args.start_index == 0:
            fout.write(json.dumps({'type': 'meta', 'created_at': now(),
                                   'config': config}) + '\n')
        for gi in range(args.start_index, args.games):
            t0 = now()
            print(f'\n----- GAME {gi+1}/{args.games} -----')
            _post('/game', {'wins': wins, 'losses': losses, 'unknown': unknown,
                            'game_index': gi, 'games': args.games, 'last_result': None})
            rec = play_one_game(args, gi)
            rec['type'] = 'game'
            rec['config_ref'] = {'sims': args.sims, 'wset': args.wset,
                                 'c_puct': args.c_puct, 'engine': 'fast_c_uct'}
            fout.write(json.dumps(rec) + '\n')

            r = rec['result']
            wins += r == 'win'; losses += r == 'loss'; unknown += r == 'unknown'
            done = gi + 1 - args.start_index
            wr = wins / max(1, wins + losses) * 100
            _post('/game', {'wins': wins, 'losses': losses, 'unknown': unknown,
                            'game_index': gi, 'games': args.games, 'last_result': r})
            print(f'  result={r} winner={rec["winner"]} red_final={rec["red_final"]} '
                  f'rounds={rec["rounds"]}  [{now()-t0:.0f}s]')
            print(f'  TALLY: {wins}W-{losses}L-{unknown}? over {done} games '
                  f'-> {wr:.1f}% (decided)')

            if gi + 1 < args.games:
                fresh = restart_game()
                if fresh is None:
                    print('  !! could not auto-restart — pausing. Inspect '
                          f'{os.path.join(PL.CAP, "restart_probe.png")} and resume with '
                          f'--start-index {gi+1}.')
                    break

        print(f'\n=== DONE: {wins}W-{losses}L-{unknown}? '
              f'decided winrate {wins/max(1,wins+losses)*100:.1f}% ===')
    finally:
        if dash_proc:
            try:
                dash_proc.terminate()
            except Exception:
                pass


if __name__ == '__main__':
    main()
