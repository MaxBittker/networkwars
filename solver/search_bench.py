"""Compare native search builds with exact root-stat parity and paired timings.

  python solver/search_bench.py /path/before.so solver/fast_engine.so

Uses identical opening/midgame positions, private dice, fixed/adaptive budgets,
play/grading modes, and alternating execution order. No strength tradeoff is
accepted: actions, visits, Qs, simulation totals, and the game RNG must match.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import statistics
import time

import numpy as np


def load(path, name):
    previous = os.environ.get('NW_ENGINE_SO')
    os.environ['NW_ENGINE_SO'] = str(Path(path).resolve())
    try:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name('fastnw.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous is None:
            os.environ.pop('NW_ENGINE_SO', None)
        else:
            os.environ['NW_ENGINE_SO'] = previous


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('before')
    ap.add_argument('after')
    ap.add_argument('--seeds', type=int, default=12)
    ap.add_argument('--sims', type=int, default=4000)
    ap.add_argument('--repeats', type=int, default=3)
    args = ap.parse_args()
    engines = [load(args.before, 'before'), load(args.after, 'after')]
    elapsed = [[], []]
    positions = 0
    for seed in range(1, args.seeds + 1):
        base = engines[0]
        g = base.new_game(seed)
        # End-turn transitions yield deterministic early and midgame positions,
        # including difficult/wiped positions; keep only live decisions.
        for turn in range(1, 5):
            if base.check_winner(g['owner']) >= 0 or not np.any(g['owner'] == 0):
                break
            positions += 1
            for grade in (0, 1):
                for repeat in range(args.repeats):
                    results = [None, None]
                    for k in ((0, 1) if repeat % 2 == 0 else (1, 0)):
                        e = engines[k]
                        e.set_topology_csr(g['n'], g['adj'])
                        e.use_mb32(g['mb'])
                        e.use_sim(0x12345678)
                        e.set_grade(grade)
                        start = time.perf_counter()
                        results[k] = e.uct_search(g['owner'], g['strength'], turn,
                            args.sims, return_q=True,
                            max_sims=args.sims * (2 if repeat == 1 else 1))
                        elapsed[k].append(time.perf_counter() - start)
                        assert e.get_mb32() == g['mb'], 'search changed game dice'
                    for a, b in zip(results[0], results[1]):
                        assert np.array_equal(a, b), (seed, turn, grade, repeat)
                    assert engines[0].sims_done() == engines[1].sims_done()
            base.use_mb32(g['mb'])
            base.end_turn(g['owner'], g['strength'])
            g['mb'] = base.get_mb32()
    total = list(map(sum, elapsed))
    ratio = statistics.median(a / b for a, b in zip(*elapsed))
    print(f'PASS: {positions} positions, {len(elapsed[0])} paired searches; exact root stats and RNG')
    print(f'Before {total[0]:.3f}s; after {total[1]:.3f}s; '
          f'aggregate speedup {total[0]/total[1]:.3f}x; median paired speedup {ratio:.3f}x')


if __name__ == '__main__':
    main()
