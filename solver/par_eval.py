#!/usr/bin/env python3
"""Parallel C-UCT self-play winrate eval. Splits seeds across processes.
Engine binary chosen via NW_ENGINE_SO env var (set BEFORE running so worker
imports pick it up). Usage:
  NW_ENGINE_SO=./fast_engine.so python par_eval.py --games 1000 --sims 8000 --workers 9
"""
import argparse, os, time
from multiprocessing import Pool


def run_chunk(arg):
    seeds, sims, c_puct, nroll, bot_policy, bot_eps = arg
    import fmcts  # imports fastnw -> loads NW_ENGINE_SO
    import fastnw
    fastnw.set_bot_policy(bot_policy, bot_eps)
    wins = 0
    for s in seeds:
        won, _ = fmcts.play_game(s, sims, c_puct, nroll)
        wins += 1 if won else 0
    return wins, len(seeds)


def main():
    import fastnw
    bot_policy_choices = tuple(fastnw.BOT_POLICY_MODES.keys())
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=1000)
    ap.add_argument('--sims', type=int, default=8000)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--workers', type=int, default=9)
    ap.add_argument('--bot-policy', choices=bot_policy_choices,
                    default='baseline')
    ap.add_argument('--bot-eps', type=float, default=0.0)
    a = ap.parse_args()

    seeds = list(range(a.seed_base, a.seed_base + a.games))
    # round-robin into `workers` chunks so each gets a mix of seeds
    chunks = [seeds[i::a.workers] for i in range(a.workers)]
    tasks = [(c, a.sims, a.c_puct, a.nroll, a.bot_policy, a.bot_eps)
             for c in chunks if c]

    print(f'ENGINE={os.environ.get("NW_ENGINE_SO","(default fast_engine.so)")}', flush=True)
    print(f'eval: {a.games} games, sims={a.sims}, c_puct={a.c_puct}, '
          f'{a.workers} workers, bot_policy={a.bot_policy}, bot_eps={a.bot_eps}',
          flush=True)
    t0 = time.time()
    with Pool(a.workers) as pool:
        res = pool.map(run_chunk, tasks)
    wins = sum(w for w, _ in res); tot = sum(n for _, n in res)
    dt = time.time() - t0
    print(f'  winrate : {wins/tot*100:.1f}%  ({wins}/{tot})', flush=True)
    print(f'  time    : {dt:.0f}s ({dt/tot*1000:.0f} ms/game wall)', flush=True)


if __name__ == '__main__':
    main()
