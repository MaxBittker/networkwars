#!/usr/bin/env python3
"""Paired-seed benchmark harness for search variants.

Runs one ARM (a named engine config) over a seed range and writes per-seed
outcomes to a JSONL so arms can be compared PAIRED (same seeds, McNemar).
Variant levers are enabled inside each worker from CLI flags (not env), so a
single driver process can launch different arms back-to-back.

  uv run python bench_ab.py --name base --games 500 --sims 2000
Compare:
  uv run python bench_ab.py --compare bench_base.jsonl bench_csplit.jsonl
"""
import argparse, json, math, os, time
from multiprocessing import Pool


def run_chunk(arg):
    seeds, sims, c_puct, nroll = arg
    import fmcts
    out = []
    for s in seeds:
        t0 = time.time()
        won, turns, tot_sims, n_moves = fmcts.play_game(s, sims, c_puct, nroll)
        out.append({'seed': s, 'won': bool(won), 'turns': turns,
                    'sims': int(tot_sims), 'moves': n_moves,
                    'ms': round((time.time() - t0) * 1000)})
    return out


def compare(files):
    runs = []
    for f in files:
        rows = [json.loads(l) for l in open(f)]
        runs.append({r['seed']: r for r in rows})
    base = runs[0]
    for f, run in zip(files, runs):
        seeds = sorted(run)
        n = len(seeds)
        w = sum(run[s]['won'] for s in seeds)
        ms = sum(run[s]['ms'] for s in seeds) / n
        line = f'{f}: {w}/{n} = {w/n*100:.1f}%  avg {ms:.0f} ms/game(cpu)'
        if run is not base:
            common = [s for s in seeds if s in base]
            ab = sum(1 for s in common if run[s]['won'] and not base[s]['won'])
            ba = sum(1 for s in common if base[s]['won'] and not run[s]['won'])
            # McNemar exact-ish: normal approx on discordant pairs
            if ab + ba > 0:
                z = (ab - ba) / math.sqrt(ab + ba)
            else:
                z = 0.0
            line += f'  | vs {files[0]}: +{ab}/-{ba} discordant, z={z:+.2f}'
        print(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--compare', nargs='+')
    ap.add_argument('--name', default='arm')
    ap.add_argument('--games', type=int, default=500)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--sims', type=int, default=2000)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--workers', type=int, default=9)
    a = ap.parse_args()

    if a.compare:
        compare(a.compare)
        return

    seeds = list(range(a.seed_base, a.seed_base + a.games))
    chunks = [seeds[i::a.workers] for i in range(a.workers)]
    tasks = [(c, a.sims, a.c_puct, a.nroll) for c in chunks if c]
    t0 = time.time()
    with Pool(a.workers) as pool:
        res = pool.map(run_chunk, tasks)
    rows = sorted((r for ch in res for r in ch), key=lambda r: r['seed'])
    out = f'bench_{a.name}.jsonl'
    with open(out, 'w') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')
    wins = sum(r['won'] for r in rows)
    dt = time.time() - t0
    print(f'{a.name}: {wins}/{len(rows)} = {wins/len(rows)*100:.1f}%  '
          f'wall {dt:.0f}s ({dt/len(rows)*1000:.0f} ms/game)  -> {out}', flush=True)


if __name__ == '__main__':
    main()
