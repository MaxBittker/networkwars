#!/usr/bin/env python3
"""Parallel C-UCT self-play winrate eval. Splits seeds across processes.
Engine binary chosen via NW_ENGINE_SO env var (set BEFORE running so worker
imports pick it up). Usage:
  NW_ENGINE_SO=./fast_engine.so python par_eval.py --games 1000 --sims 8000 --workers 9
"""
import argparse, os, time
from multiprocessing import Pool


def run_chunk(arg):
    seeds, sims, c_puct, nroll, max_sims = arg
    import fmcts  # imports fastnw -> loads NW_ENGINE_SO
    wins = 0
    for s in seeds:
        won, *_ = fmcts.play_game(s, sims, c_puct, nroll, max_sims=max_sims)
        wins += 1 if won else 0
    return wins, len(seeds)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=1000)
    ap.add_argument('--sims', type=int, default=8000,
                    help='sim floor (with --max-sims, the adaptive visit-margin stop)')
    ap.add_argument('--max-sims', type=int, default=0,
                    help='sim ceiling for adaptive search (0 = fixed --sims)')
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--workers', type=int, default=9)
    a = ap.parse_args()

    max_sims = a.max_sims if a.max_sims > a.sims else None
    seeds = list(range(a.seed_base, a.seed_base + a.games))
    # round-robin into many small chunks (8 per worker) so the pool load-balances:
    # game costs are heavy-tailed (especially with --max-sims), and one static
    # chunk per worker leaves 8 workers idle waiting on the unluckiest one's tail.
    nchunks = 8 * a.workers
    chunks = [seeds[i::nchunks] for i in range(nchunks)]
    tasks = [(c, a.sims, a.c_puct, a.nroll, max_sims) for c in chunks if c]

    print(f'ENGINE={os.environ.get("NW_ENGINE_SO","(default fast_engine.so)")}', flush=True)
    print(f'eval: {a.games} games, sims={a.sims}'
          f'{f"-{a.max_sims} adaptive" if max_sims else ""}, c_puct={a.c_puct}, '
          f'{a.workers} workers', flush=True)
    t0 = time.time()
    with Pool(a.workers) as pool:
        res = pool.map(run_chunk, tasks)
    wins = sum(w for w, _ in res); tot = sum(n for _, n in res)
    dt = time.time() - t0
    print(f'  winrate : {wins/tot*100:.1f}%  ({wins}/{tot})', flush=True)
    print(f'  time    : {dt:.0f}s ({dt/tot*1000:.0f} ms/game wall)', flush=True)


if __name__ == '__main__':
    main()
