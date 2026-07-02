#!/usr/bin/env python3
"""Build a HARD TEST SET of live-lost openings and score how winnable each is.

Part 1 of the winrate push. Harvests every clean round-0 opening that LOST in a
live series (across all runs/series_*.jsonl), dedups them, then re-scores each
one offline with K fresh dice seeds at a fixed sim budget (same engine, no seed
exploitation). The winnable% splits the set into:

  * dice-bound  (winnable% < LOW)   — the deal/dice doom the game; no search or
                                       heuristic change can rescue these.
  * contested   (LOW..HIGH)         — the REAL test set: search has leverage here.
  * easy        (winnable% > HIGH)   — we should already win; live loss was a
                                       one-off dice/OCR/execution slip.

Writes hard_set.jsonl (one board + live_result + winnable% per line). A/B tools
(hard_ab.py) then replay the CONTESTED band with paired seeds to measure whether
an idea actually helps where it can.

  uv run python hard_set.py --score --seeds 24 --sims 4000
  uv run python hard_set.py --score --seeds 24 --sims 4000 --include-wins
"""
import argparse, glob, json, os, sys, time
from collections import Counter
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import open_board_eval as OBE   # reuse run_chunk (one board x seeds -> wins/tot)

DEFAULT_LOGS = sorted(glob.glob(os.path.join(HERE, 'runs', 'series_*.jsonl'))) + [
    os.path.join(HERE, 'runs', 'loop_series.jsonl'),
]


def board_key(bb):
    return tuple(sorted((n['id'], n['o'], n['s']) for n in bb))


def harvest(files, include_wins):
    """Return list of {board, result, src} for clean, standard, deduped openings."""
    out, seen = [], set()
    for f in files:
        if not os.path.exists(f):
            continue
        for line in open(f):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if 'trajectory' not in r:
                continue
            result = r.get('result')
            if result not in ('loss',) and not (include_wins and result == 'win'):
                continue
            tj = r.get('trajectory') or []
            if not tj:
                continue
            bb = tj[0].get('board_before')
            if not bb or len(bb) != 30 or any(n.get('s') is None for n in bb):
                continue
            cc = Counter(n['o'] for n in bb)
            if len(cc) != 5 or any(v != 6 for v in cc.values()):
                continue
            k = board_key(bb)
            if k in seen:
                continue
            seen.add(k)
            nodes = [{'id': n['id'], 'col': n['c'], 'row': n['r'],
                      'owner': n['o'], 'strength': n['s']} for n in bb]
            out.append({'board': {'nodes': nodes}, 'result': result,
                        'src': os.path.basename(f), 'game_index': r.get('game_index')})
    return out


def score_task(arg):
    board, seeds, sims, c_puct, min_sims = arg
    w, t = OBE.run_chunk(([board], seeds, sims, c_puct, min_sims))
    return w, t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--score', action='store_true', help='re-score winnable%% (else just harvest+count)')
    ap.add_argument('--seeds', type=int, default=24, help='dice seeds per opening')
    ap.add_argument('--sims', type=int, default=4000)
    ap.add_argument('--min-sims', type=int, default=0,
                    help='adaptive floor (0 = fixed --sims budget); move-identical')
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--workers', type=int, default=9)
    ap.add_argument('--low', type=float, default=0.40, help='dice-bound ceiling')
    ap.add_argument('--high', type=float, default=0.85, help='easy floor')
    ap.add_argument('--include-wins', action='store_true')
    ap.add_argument('--out', default=os.path.join(HERE, 'hard_set.jsonl'))
    ap.add_argument('files', nargs='*', default=DEFAULT_LOGS)
    a = ap.parse_args()

    pool_openings = harvest(a.files, a.include_wins)
    print(f"harvested {len(pool_openings)} clean/standard/deduped openings "
          f"(losses{' + wins' if a.include_wins else ''}) from {len(a.files)} logs", flush=True)
    if not a.score:
        return

    seeds = list(range(1, a.seeds + 1))
    tasks = [(o['board'], seeds, a.sims, a.c_puct, a.min_sims or a.sims)
             for o in pool_openings]
    t0 = time.time()
    with Pool(a.workers) as pool:
        res = pool.map(score_task, tasks)

    rows = []
    for o, (w, t) in zip(pool_openings, res):
        o2 = dict(o)
        o2['winnable'] = w / t
        o2['w'] = w
        o2['t'] = t
        rows.append(o2)

    rows.sort(key=lambda r: r['winnable'])
    with open(a.out, 'w') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')

    dice = [r for r in rows if r['winnable'] < a.low]
    cont = [r for r in rows if a.low <= r['winnable'] <= a.high]
    easy = [r for r in rows if r['winnable'] > a.high]
    dt = time.time() - t0
    print(f"\nscored {len(rows)} openings x {a.seeds} seeds @ {a.sims} sims  "
          f"[{dt:.0f}s]  -> {os.path.basename(a.out)}")
    print(f"  mean winnable across lost openings: {sum(r['winnable'] for r in rows)/len(rows)*100:.1f}%")
    print(f"  dice-bound (<{a.low:.0%}): {len(dice):3d}   "
          f"contested [{a.low:.0%}-{a.high:.0%}]: {len(cont):3d}   "
          f"easy (>{a.high:.0%}): {len(easy):3d}")
    print(f"\n  CONTESTED band (the test set — search has leverage here):")
    for r in cont:
        print(f"    {r['winnable']*100:5.1f}%  ({r['w']:2d}/{r['t']})  {r['src']} g{r['game_index']}")


if __name__ == '__main__':
    main()
