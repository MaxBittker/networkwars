#!/usr/bin/env python3
"""Drive a live iOS Network Wars game with the mcts.js policy.

Loop per RED turn:
  - deselect, settle, capture, parse (validated)
  - ask nwmove.js for one move; if attack -> tap source, tap target; repeat
  - if stop -> tap End Turn, wait for bots
Stops on win (>=24), only-one-faction, repeated parse failure (likely modal), or
--max-rounds. Every parsed state is saved to captures/ for later analysis.

Usage: play.py [--max-rounds N] [--rollout strong|safety|cheap] [--max-attacks N]
"""
import os, sys, json, time, subprocess, argparse, urllib.request
import numpy as np
from PIL import Image
import parse as P

HERE = os.path.dirname(os.path.abspath(__file__))
CAP = os.path.join(HERE, 'captures')
os.makedirs(CAP, exist_ok=True)
NWCAP = os.path.join(HERE, 'nwcap.sh')
WIN_NODES = 24
END_TURN = (281, 643)      # logical coords of "End Turn"
DESELECT = (12, 500)       # empty left margin

# settle/stabilize: poll cheap screenshot diffs and parse only once the screen
# stops animating, instead of fixed long sleeps + repeated full parses.
DIFF_THRESH = 2.5          # mean 0-255 gray delta below which the screen is "settled"
SETTLE_POLL = 0.3          # s between settle polls
SERVER_PORT = 8777


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True)


def shot(name):
    path = os.path.join(CAP, name)
    sh('bash', NWCAP, 'shot', path)
    return path


def tap(lx, ly):
    sh('bash', NWCAP, 'tap', str(int(lx)), str(int(ly)))


def tap_fast(lx, ly):
    """Tap without the per-call activate/reposition/sleep (~20ms vs ~1.2s).
    Safe as long as the window is pinned + frontmost — we `place()` per turn."""
    sh('bash', NWCAP, 'tapfast', str(int(lx)), str(int(ly)))


def place():
    """Pin window on-screen + bring iPhone Mirroring frontmost. Call once per turn."""
    return sh('bash', NWCAP, 'place').stdout.strip()


def deselect():
    tap_fast(*DESELECT)
    time.sleep(0.2)


def _thumb(path):
    """Small grayscale array for fast frame-to-frame motion detection."""
    return np.asarray(Image.open(path).convert('L').resize((64, 140)), dtype=np.float32)


def fingerprint(st):
    """Owner+strength keyed by pixel-cell, order-independent; None if board invalid.
    Requires the real app's 6-col x 7-row grid so the parse matches the model's
    fixed input layout (an 8-row mis-parse would overflow the observation)."""
    nodes = {(n['row'], n['col']): (n['owner'], n['strength']) for n in st['nodes']}
    g = st['grid']
    total = sum(st['counts'].values())
    if (total != 30 or len(nodes) != 30 or st['warnings']
            or g['rows'] != 7 or g['cols'] != 6):
        return None
    return tuple(sorted((rc, v) for rc, v in nodes.items()))


OCR = os.path.join(HERE, 'ocr')


def is_game_over(path):
    """Detect the end-of-game modal via OCR (board screens never show these words)."""
    out = sh(OCR, path).stdout.lower()
    return any(w in out for w in ('again', 'you lost', 'you won', 'winner'))


def capture_state(tag, max_tries=30):
    """Poll screenshots until the screen stops animating (cheap gray-diff), then
    parse settled frames and accept only when TWO consecutive parses are identical
    — this rejects mid-count digit animation (a node's number ticking up/down while
    the rest of the board is static slips under the diff threshold). No routine
    deselect (the selection clears after an attack); a lingering selection that
    corrupts the parse triggers a one-shot deselect fallback. ('over', None) on a
    game-over modal."""
    prev = None
    last_fp = None
    last_st = None
    obscured = 0
    tried_deselect = False
    for k in range(max_tries):
        path = shot(f'{tag}.png')
        th = _thumb(path)
        settled = prev is not None and np.abs(th - prev).mean() < DIFF_THRESH
        prev = th
        if settled:
            st = P.parse(path)
            fp = fingerprint(st)
            if fp is not None:
                if fp == last_fp:                   # two identical valid parses
                    with open(os.path.join(CAP, f'{tag}.json'), 'w') as f:
                        json.dump(st, f, indent=2)
                    return st, fp
                last_fp, last_st = fp, st
            else:
                last_fp = None
                total = sum(st['counts'].values())
                if is_game_over(path) or total < 12:    # modal / covered board
                    obscured += 1
                    if obscured >= 2:
                        return 'over', None
                elif not tried_deselect:            # maybe a stuck selection — clear it once
                    deselect()
                    tried_deselect = True
                    prev = None
        time.sleep(SETTLE_POLL)
    return last_st, None


def board_str(st):
    nodes = {(n['row'], n['col']): n for n in st['nodes']}
    out = []
    for r in range(st['grid']['rows']):
        row = ''
        for c in range(st['grid']['cols']):
            n = nodes.get((r, c))
            row += (f" {n['owner'][0].upper()}{n['strength'] if n['strength'] is not None else '?'}".ljust(4)) if n else '  . '
        out.append(row)
    return '\n'.join(out)


PYTHON = os.path.join(os.path.dirname(HERE), '.venv', 'bin', 'python')


def start_server(port):
    """Launch the persistent neural-MCTS server (model loaded once) and wait for it."""
    proc = subprocess.Popen([PYTHON, os.path.join(HERE, 'nwserver.py'), '--port', str(port)])
    url = f'http://127.0.0.1:{port}'
    for _ in range(60):
        try:
            if urllib.request.urlopen(url + '/healthz', timeout=1).read() == b'ok':
                return proc, url
        except Exception:
            time.sleep(0.5)
    raise RuntimeError('nwserver failed to start')


def mcts_move(st, rollout, engine='js', sims=100, turns=1, server_url=None,
              wset='C1', c_puct=2.5, nroll=1):
    if engine == 'nn':   # neural MCTS via persistent server (model already resident)
        body = json.dumps({'board': st, 'sims': sims, 'turns': turns}).encode()
        req = urllib.request.Request(server_url + '/move', data=body,
                                     headers={'Content-Type': 'application/json'})
        try:
            return json.loads(urllib.request.urlopen(req, timeout=30).read())
        except Exception as e:
            print('  server error -> ending turn:', e)
            return {'action': 'stop'}
    if engine == 'fast':   # pure C UCT (fast_engine.so, no net) — the ~78-80% config
        tmp = os.path.join(CAP, '_state.json')
        with open(tmp, 'w') as f:
            json.dump(st, f)
        r = sh(PYTHON, os.path.join(HERE, 'nwmove_fast.py'), tmp,
               '--sims', str(sims), '--turns', str(turns), '--wset', wset,
               '--c-puct', str(c_puct), '--nroll', str(nroll))
        line = r.stdout.strip().split('\n')[-1] if r.stdout.strip() else ''
        if not line:
            print('  nwmove_fast stderr:', r.stderr[-300:])
            return {'action': 'stop'}
        return json.loads(line)
    # JS flat MCTS (mcts.js)
    tmp = os.path.join(CAP, '_state.json')
    with open(tmp, 'w') as f:
        json.dump(st, f)
    r = sh('node', os.path.join(HERE, 'nwmove.js'), tmp, rollout)
    line = r.stdout.strip().split('\n')[-1] if r.stdout.strip() else ''
    if not line:
        print('  nwmove stderr:', r.stderr[-300:])
        return {'action': 'stop'}
    return json.loads(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-rounds', type=int, default=3)
    ap.add_argument('--rollout', default='strong')
    ap.add_argument('--max-attacks', type=int, default=12)
    ap.add_argument('--engine', default='js', choices=['js', 'nn', 'fast'],
                    help="'js'=mcts.js flat MCTS; 'nn'=mcts.py+sl_cnn.pt; 'fast'=pure C UCT")
    ap.add_argument('--sims', type=int, default=100, help='MCTS simulations/move (fast: 8000)')
    ap.add_argument('--wset', default='C1', help='fast engine ranked weight set')
    ap.add_argument('--c-puct', type=float, default=2.5, help='fast engine PUCT exploration')
    ap.add_argument('--nroll', type=int, default=1, help='fast engine rollouts per leaf')
    ap.add_argument('--port', type=int, default=SERVER_PORT)
    args = ap.parse_args()
    if args.engine == 'fast' and args.sims < 1000:
        args.sims = 8000   # pure-MCTS needs a real budget; 100 is a neural-MCTS default

    # pin window on-screen so taps register (off-display buttons = dead clicks)
    print('placing window:', place())

    server_proc, server_url = None, None
    if args.engine == 'nn':
        server_proc, server_url = start_server(args.port)
        print(f'\n*** neural-MCTS server up — open the live dashboard: {server_url} ***\n')

    try:
        play_loop(args, server_url)
    finally:
        if server_proc:
            server_proc.terminate()
    print("\nDone. States saved in captures/.")


def play_loop(args, server_url):
    for rnd in range(args.max_rounds):
        print(f"\n===== ROUND {rnd}  (RED turn) =====")
        place()   # re-pin + refocus once per turn; taps within the turn use tap_fast
        st, fp = capture_state(f'r{rnd}_t0')
        if st == 'over':
            print("  GAME OVER modal detected. Stopping. See captures/.")
            break
        if fp is None:
            print("  could not stabilize parse after retries; stopping. See captures/.")
            break
        print(board_str(st))
        print('  counts', st['counts'])
        if max(st['counts'].values()) >= WIN_NODES:
            print(f"  GAME OVER: {max(st['counts'], key=st['counts'].get)} has >= {WIN_NODES}.")
            break
        if st['counts']['red'] == 0:
            print("  RED eliminated. Stopping.")
            break

        # RED attacks until mcts says stop
        misses = 0
        for a in range(args.max_attacks):
            mv = mcts_move(st, args.rollout, engine=args.engine, sims=args.sims,
                           turns=rnd + 1, server_url=server_url,
                           wset=args.wset, c_puct=args.c_puct, nroll=args.nroll)
            if mv['action'] == 'stop':
                print(f"  mcts: STOP after {a} attacks")
                break
            fx, fy = mv['fromPx']; tx, ty = mv['toPx']
            print(f"  attack #{a}: node{mv['from']}(px {fx:.0f},{fy:.0f}) -> node{mv['to']}(px {tx:.0f},{ty:.0f})")
            tap_fast(round(fx/2), round(fy/2)); time.sleep(0.3)
            tap_fast(round(tx/2), round(ty/2)); time.sleep(0.3)   # capture_state settles the rest
            st2, fp2 = capture_state(f'r{rnd}_a{a}')
            if st2 == 'over':
                print("  GAME OVER mid-turn."); fp = None; break
            if fp2 is None:
                print("  parse invalid after attack; stopping turn.")
                break
            if fp2 == fp:
                misses += 1
                print(f"   no board change (miss {misses}); re-pinning + retry")
                place()   # a miss is often window drift — re-pin and try again
                if misses >= 2:
                    print("   repeated misses; ending turn.")
                    break
                continue
            misses = 0
            st, fp = st2, fp2
            print('   ->', st['counts'])
        else:
            print("  hit max-attacks cap")

        # End turn -> bots play (capture_state then waits out bot animations via diff-settle)
        print("  End Turn")
        tap_fast(*END_TURN)
        time.sleep(1.0)


if __name__ == '__main__':
    main()
