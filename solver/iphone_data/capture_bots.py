#!/usr/bin/env python3
"""Fine-grained BOT-TURN capture: reverse-engineer the real iOS opponent AI.

The normal series driver snapshots the board ONCE after all four bots animate, so
cross-faction cascades are invisible (green softens a node, yellow captures it —
indistinguishable from a single faction breaking the greedy rule). This tool
instead BURST-captures through the whole bot-animation window after End Turn and
keeps every DISTINCT valid board in order, so each consecutive pair isolates
(close to) one faction's sub-moves.

Per round it logs:
  - board_before        (red's start-of-turn board)
  - red_moves           (the attacks red actually made, with intermediate boards)
  - red_post_board      (board after red's attacks, BEFORE End Turn / reinforce)
  - bot_frames          (ordered list of every distinct valid board observed during
                         the bot animation: {t, counts, board})
Red is driven by the C-UCT engine only to generate realistic turns — its strength
is irrelevant here; we are observing the bots. NEVER surrenders (repo policy).

Usage:
  python capture_bots.py --games 3 --sims 2000 [--out runs/botcap.jsonl]
                         [--burst-secs 30] [--settle-repeats 6]
Run it only while iPhone Mirroring is live (lock the phone if you see "iPhone in Use").
"""
import argparse, json, os, time
import play as PL
import parse as P

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, 'runs')
os.makedirs(RUNS, exist_ok=True)
WIN_NODES = PL.WIN_NODES


def now():
    return time.time()


def board_of(st):
    return [{'id': n['id'], 'r': n['row'], 'c': n['col'],
             'o': n['owner'], 's': n['strength']} for n in st['nodes']]


def counts_winner(counts):
    for f, c in counts.items():
        if c >= WIN_NODES:
            return f
    return None


def burst_bots(tag, burst_secs, settle_repeats):
    """After End Turn, rapidly shot+parse and collect every DISTINCT valid board in
    order. Stop when the latest valid board repeats `settle_repeats` times (bots are
    done) or `burst_secs` elapses. Returns (frames, over) where frames is a list of
    {t, counts, board, shot} and `over` flags a game-over modal mid-burst."""
    frames = []
    last_fp = None
    repeats = 0
    t0 = now()
    i = 0
    over = False
    while now() - t0 < burst_secs:
        path = PL.shot(f'{tag}_b{i:03d}.png')
        i += 1
        if not os.path.exists(path):
            time.sleep(0.1)
            continue
        st = P.parse(path)
        fp = PL.fingerprint(st)
        if fp is not None:
            if fp == last_fp:
                repeats += 1
                if repeats >= settle_repeats:
                    break
            else:
                repeats = 1
                last_fp = fp
                frames.append({'t': round(now() - t0, 3),
                               'counts': dict(st['counts']),
                               'board': board_of(st),
                               'shot': os.path.basename(path)})
                if counts_winner(st['counts']) is not None:
                    over = True
                    break
        else:
            repeats = 0
            # cheap game-over probe only when the board is unreadable
            if sum(st['counts'].values()) < 12 and PL.is_game_over(path):
                over = True
                break
        # no extra sleep — shot+parse (~0.2s) is the natural poll interval
    return frames, over


def play_one_game(args, gi):
    rec = {'game_index': gi, 'started_at': now(), 'result': 'unknown',
           'winner': None, 'rounds': 0, 'rounds_data': []}
    PL.place()
    for ex, ey in ((12, 380), (306, 380), (12, 380)):
        PL.tap(ex, ey); time.sleep(0.2)
    st, fp = PL.capture_state(f'bc_g{gi}_r0')
    if st == 'over' or fp is None:
        rec['note'] = 'no board at game start'; rec['ended_at'] = now(); return rec

    for rnd in range(args.max_rounds):
        rec['rounds'] = rnd + 1
        w = counts_winner(st['counts'])
        if w is not None:
            rec['result'] = 'win' if w == 'red' else 'loss'; rec['winner'] = w; break
        if st['counts'].get('red', 0) == 0:
            rec['result'] = 'loss'; rec['note'] = 'red eliminated'; break

        rd = {'round': rnd, 'counts_before': dict(st['counts']),
              'board_before': board_of(st), 'red_moves': [], 'bot_frames': []}

        # ---- RED turn (engine-driven; full tap() for reliable landing) ----
        over_mid = False
        misses = 0
        for a in range(args.max_attacks):
            mv = PL.mcts_move(st, 'strong', engine='fast', sims=args.sims,
                              turns=rnd + 1, wset=args.wset, c_puct=args.c_puct, nroll=1)
            if mv.get('action') == 'stop':
                break
            fx, fy = mv['fromPx']; tx, ty = mv['toPx']
            PL.tap(round(fx / 2), round(fy / 2)); time.sleep(0.3)
            PL.tap(round(tx / 2), round(ty / 2)); time.sleep(0.4)
            st2, fp2 = PL.capture_state(f'bc_g{gi}_r{rnd}_a{a}')
            mvr = {'from': mv['from'], 'to': mv['to'], 'winexp': mv.get('winexp')}
            if st2 == 'over':
                mvr['result'] = 'over'; rd['red_moves'].append(mvr); over_mid = True; break
            if fp2 is None:
                mvr['result'] = 'parse_invalid'; rd['red_moves'].append(mvr); break
            if fp2 == fp:
                misses += 1; mvr['result'] = f'miss{misses}'; rd['red_moves'].append(mvr)
                PL.place()
                if misses >= 2: break
                continue
            misses = 0
            mvr['result'] = 'applied'; mvr['board_after'] = board_of(st2)
            rd['red_moves'].append(mvr)
            st, fp = st2, fp2
            if counts_winner(st['counts']) == 'red': break

        rd['red_post_board'] = board_of(st)
        rd['red_post_counts'] = dict(st['counts'])
        if over_mid or counts_winner(st['counts']) is not None:
            rec['rounds_data'].append(rd)
            w = counts_winner(st['counts'])
            if w: rec['result'] = 'win' if w == 'red' else 'loss'; rec['winner'] = w
            break

        # ---- End Turn -> BURST capture the bot animation ----
        PL.tap(*PL.END_TURN)
        time.sleep(0.6)
        frames, over = burst_bots(f'bc_g{gi}_r{rnd}', args.burst_secs, args.settle_repeats)
        rd['bot_frames'] = frames
        rd['n_bot_frames'] = len(frames)
        rec['rounds_data'].append(rd)
        print(f'   round {rnd+1}: red_post={rd["red_post_counts"]}  '
              f'captured {len(frames)} distinct bot frames'
              + (f' [counts seq: {[f["counts"] for f in frames]}]' if args.verbose else ''))

        if over:
            # settle on the final board to classify
            st3, fp3 = PL.capture_state(f'bc_g{gi}_r{rnd}_fin', max_tries=20)
            if st3 not in ('over', None) and fp3 is not None:
                st, fp = st3, fp3
            w = counts_winner(st['counts'])
            if w: rec['result'] = 'win' if w == 'red' else 'loss'; rec['winner'] = w
            break

        # final frame of the burst is the next round's start board
        if frames:
            # re-stabilize a clean parse for the engine's next move
            st4, fp4 = PL.capture_state(f'bc_g{gi}_r{rnd}_settle', max_tries=20)
            if fp4 is not None:
                st, fp = st4, fp4
        else:
            print('   !! burst captured 0 frames — falling back to settle capture')
            st4, fp4 = PL.capture_state(f'bc_g{gi}_r{rnd}_settle', max_tries=45)
            if fp4 is None:
                rec['note'] = 'could not stabilize after bots'; break
            st, fp = st4, fp4

    rec['red_final'] = st['counts'].get('red') if isinstance(st, dict) else None
    rec['ended_at'] = now()
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=3)
    ap.add_argument('--sims', type=int, default=2000, help='red search budget (strength irrelevant here)')
    ap.add_argument('--wset', default='C1')
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--max-rounds', type=int, default=80)
    ap.add_argument('--max-attacks', type=int, default=14)
    ap.add_argument('--burst-secs', type=float, default=30.0,
                    help='max seconds to burst-capture per bot phase')
    ap.add_argument('--settle-repeats', type=int, default=6,
                    help='consecutive identical valid frames that mark "bots done"')
    ap.add_argument('--out', default=os.path.join(RUNS, 'botcap.jsonl'))
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    print(f'=== BOT-CAPTURE: {args.games} games, burst={args.burst_secs}s '
          f'settle={args.settle_repeats} ===')
    print(f'logging -> {args.out}')
    PL.place()
    wins = losses = 0
    with open(args.out, 'a', buffering=1) as fout:
        fout.write(json.dumps({'type': 'meta', 'created_at': now(),
                               'note': 'fine-grained bot-turn burst capture',
                               'settle_repeats': args.settle_repeats,
                               'burst_secs': args.burst_secs}) + '\n')
        for gi in range(args.games):
            print(f'\n----- GAME {gi+1}/{args.games} -----')
            rec = play_one_game(args, gi)
            rec['type'] = 'game'
            fout.write(json.dumps(rec) + '\n')
            wins += rec['result'] == 'win'; losses += rec['result'] == 'loss'
            print(f'  result={rec["result"]} rounds={rec["rounds"]} '
                  f'frames/round avg={sum(r.get("n_bot_frames",0) for r in rec["rounds_data"])/max(1,len(rec["rounds_data"])):.1f}')
            if gi + 1 < args.games:
                # reuse series-style restart via the post-game modal (never surrender)
                import series as S
                fresh = S.restart_game()
                if fresh is None:
                    print('  !! could not auto-restart; stopping. Resume later.')
                    break
    print(f'\n=== DONE: {wins}W-{losses}L ===')


if __name__ == '__main__':
    main()
