#!/usr/bin/env python3
"""Replay the EXACT round-0 opening boards of the games that LOST in a live
series, N times each with fresh battle dice, to measure how often each lost
start is actually winnable in sim (same engine: C-UCT + greedy bots + power-ratio
battle). Separates "doomed deal" (low %) from "unlucky" (high %).

Reuses open_board_eval.run_chunk's proven play loop (one board x one seed -> one
self-play game to terminal).

Usage: python target_lost_starts.py runs/series_100game_*.jsonl \
           --games 15,42,45,67,81,89 --runs 20 --sims 16000
"""
import argparse, json, os, sys, time
from collections import Counter
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import open_board_eval as OBE   # reuse run_chunk (the play loop)


def load_loss_openings(runfile, want_games):
    """Return {game_index: board-dict} for the requested games' round-0 board."""
    out = {}
    for line in open(runfile):
        try: r = json.loads(line)
        except: continue
        if r.get('type') == 'meta':
            continue
        gi = r.get('game_index')
        if gi not in want_games:
            continue
        tj = r.get('trajectory') or []
        if not tj:
            continue
        bb = tj[0].get('board_before')
        if not bb or len(bb) != 30 or any(n.get('s') is None for n in bb):
            continue
        out[gi] = {'nodes': [{'id': n['id'], 'col': n['c'], 'row': n['r'],
                              'owner': n['o'], 'strength': n['s']} for n in bb]}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('runfile')
    ap.add_argument('--games', default='15,42,45,67,81,89')
    ap.add_argument('--runs', type=int, default=20, help='dice seeds per board')
    ap.add_argument('--sims', type=int, default=16000)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--workers', type=int, default=9)
    a = ap.parse_args()

    want = [int(x) for x in a.games.split(',')]
    boards = load_loss_openings(a.runfile, set(want))
    seeds = list(range(1, a.runs + 1))
    print(f"replaying {len(boards)} lost openings x {a.runs} dice seeds = "
          f"{len(boards)*a.runs} games, sims={a.sims}\n", flush=True)

    grand_w = grand_t = 0
    t0 = time.time()
    for gi in want:
        if gi not in boards:
            print(f"  g{gi}: (could not load opening)"); continue
        b = boards[gi]
        cc = Counter(n['owner'] for n in b['nodes'])
        std = (len(cc) == 5 and all(cc[c] == 6 for c in cc))
        # one board, fan the seeds across workers
        chunks = [[b]] * 0  # placeholder
        # OBE.run_chunk takes (boards, seeds, sims, c_puct); split seeds across workers
        sd_chunks = [seeds[i::a.workers] for i in range(a.workers)]
        tasks = [([b], sc, a.sims, a.c_puct) for sc in sd_chunks if sc]
        with Pool(len(tasks)) as pool:
            res = pool.map(OBE.run_chunk, tasks)
        w = sum(x for x, _ in res); t = sum(y for _, y in res)
        grand_w += w; grand_t += t
        flag = '' if std else '  [NON-STANDARD opening: ' + str(dict(cc)) + ']'
        print(f"  g{gi}: {w}/{t} winnable = {100*w/t:.0f}%{flag}", flush=True)

    print(f"\n  OVERALL: {grand_w}/{grand_t} = {100*grand_w/grand_t:.1f}% "
          f"winnable across the lost starts  [{time.time()-t0:.0f}s]", flush=True)
    print("  (these all LOST live; sim-generated openings score ~94-96% same config)")


if __name__ == '__main__':
    main()
