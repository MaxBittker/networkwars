#!/usr/bin/env python3
"""Drive a live iOS Network Wars game with the pure C-UCT policy.

Loop per RED turn:
  - deselect, settle, capture, parse (validated)
  - ask nwmove_fast.py for one move; if attack -> tap source, tap target; repeat
  - if stop -> tap End Turn, wait for bots
Stops on win (>=24), only-one-faction, repeated parse failure (likely modal), or
--max-rounds. Every parsed state is saved to captures/ for later analysis.

Usage: play.py [--max-rounds N] [--max-attacks N] [--sims N]
"""
import os, sys, json, time, subprocess, argparse
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


def _deselect_glow(path, st):
    """A node parsed as strength None is a SELECTED node — its selection glow
    floods the digit so it can't be read. You deselect by tapping the node itself
    (empty-margin taps do NOT deselect in this game). Tap the most-glowing
    unreadable node (the selection source; its attack-lines also blank neighbors,
    so clearing it fixes them too). Returns True if it tapped something."""
    bad = [n for n in st['nodes'] if n.get('strength') is None]
    if not bad:
        return False
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.int16)
    H, W, _ = im.shape

    def glow(n):
        x, y, r = int(n['px']), int(n['py']), 30
        b = im[max(0, y-r):y+r, max(0, x-r):x+r]
        return int(((b[:, :, 0] > 150) & (b[:, :, 1] > 150) & (b[:, :, 2] > 150)).sum())

    src = max(bad, key=glow)                       # the selected source = brightest glow
    tap(round(src['px'] / 2), round(src['py'] / 2))   # tap it to toggle the selection off
    return True


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
    deselects = 0
    for k in range(max_tries):
        path = shot(f'{tag}.png')
        if not os.path.exists(path):   # screencapture failed (window vanished / link drop)
            time.sleep(SETTLE_POLL)
            prev = None                # force a fresh settle once it comes back
            continue
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
                # An unreadable node is a SELECTED node (its glow floods the digit).
                # You DESELECT it by tapping the node itself — empty-margin taps do
                # NOT deselect in this game. Tap the most-glowing unreadable node.
                elif deselects < 3 and _deselect_glow(path, st):
                    deselects += 1
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


def mcts_move(st, rollout, engine='fast', sims=8000, turns=1,
              wset='C1', c_puct=2.5, nroll=1):
    """Pure C-UCT move (fast_engine.so, no net) — the ~78-80% config. The `rollout`
    and `engine` args are vestigial (kept for the call signature)."""
    tmp = os.path.join(CAP, '_state.json')
    with open(tmp, 'w') as f:
        json.dump(st, f)
    # retry: a transient empty stdout (subprocess hiccup) must NOT be misread as
    # 'stop' — that silently passes the turn and can stall a whole game.
    for attempt in range(3):
        r = sh(PYTHON, os.path.join(HERE, 'nwmove_fast.py'), tmp,
               '--sims', str(sims), '--turns', str(turns), '--wset', wset,
               '--c-puct', str(c_puct), '--nroll', str(nroll))
        line = r.stdout.strip().split('\n')[-1] if r.stdout.strip() else ''
        if line:
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                line = ''
        if attempt < 2:
            time.sleep(0.4)
    print('  nwmove_fast empty after retries; stderr:', r.stderr[-200:])
    return {'action': 'stop'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-rounds', type=int, default=3)
    ap.add_argument('--rollout', default='strong')   # unused by fast engine; kept for mcts_move sig
    ap.add_argument('--max-attacks', type=int, default=12)
    ap.add_argument('--sims', type=int, default=8000, help='MCTS simulations/move')
    ap.add_argument('--wset', default='C1', help='fast engine ranked weight set')
    ap.add_argument('--c-puct', type=float, default=2.5, help='fast engine PUCT exploration')
    ap.add_argument('--nroll', type=int, default=1, help='fast engine rollouts per leaf')
    args = ap.parse_args()

    # pin window on-screen so taps register (off-display buttons = dead clicks)
    print('placing window:', place())

    play_loop(args)
    print("\nDone. States saved in captures/.")


def play_loop(args):
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
            mv = mcts_move(st, args.rollout, engine='fast', sims=args.sims,
                           turns=rnd + 1,
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
