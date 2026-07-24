"""Compare candidate sweep-up triggers on two axes: is the offer HONEST, and is it
still USEFUL?

sweep_audit.py showed the shipped trigger (search says every root move wins
> 0.9995) fires in 142/144 games at a median of turn 2 / 10 RED nodes, and the
greedy mop-up it hands the game to then loses 5.2% of the time. Raising the
threshold cannot fix that: q is a mean of 0/1 rollouts, and the grading snapshot is
taken at max_sims/2 while the value-stop ends the search ~96 sims later, so each
root child's reported Q averages ~20 rollouts — it reads exactly 1.0 whenever none
of those ~20 happened to lose. No threshold below 1.0 can resolve 99% from 100%.

The candidates, evaluated at every RED decision of full games:
  t0  shipped h2h trigger        (grade, 4000-8000, q > 0.9995 for every move)
  t1  same but max_sims == sims  (grade window = half the ACTUAL spend, not 96 sims)
  t2  grade 16000 fixed
  mc400/mc1000  Monte-Carlo certificate of the policy the button actually runs:
      play the greedy sweep to terminal N times on fresh dice; offer only on N/N.

For each variant: how often/how early it fires (usefulness) and, from its own first
firing position, the greedy sweep's true win rate over fresh playouts drawn from a
DISJOINT dice-seed range (honesty).

    uv run python sweep_variants.py --seeds 1-20 --out /tmp/var.jsonl
    uv run python sweep_variants.py --report '/tmp/var_*.jsonl'
"""
import argparse
import glob
import json
import math
import sys

import numpy as np

import fastnw
from sweep_audit import (RED, MAX_TURNS, VS, fires, greedy_playout, search,
                        sweep_move, terminal)

TRIGGERS = {
    't0': dict(grade=1, sims=4000, max_sims=8000),      # shipped (head-to-head.html)
    't1': dict(grade=1, sims=8000, max_sims=8000),      # honest grading window
    't2': dict(grade=1, sims=16000, max_sims=16000),
}
MC = {'mc400': 400, 'mc1000': 1000}
TRUTH_K = 400
# Disjoint dice-seed spaces so a position is never certified and judged on the same
# coins (that would bias the honesty number toward the certificate).
CERT_BASE, TRUTH_BASE = 0x10000000, 0x60000000


def dice_seed(base, seed, turn, i):
    return (base + seed * 7919 + turn * 1000003 + i * 104729) & 0xFFFFFFFF


def mc_certify(owner, strength, turns, adj, seed, n):
    """Play the greedy sweep policy to terminal n times on fresh dice. Returns wins
    (stops early on the first loss — a single loss already fails the gate)."""
    for i in range(n):
        won, _ = greedy_playout(owner, strength, turns, adj,
                                dice_seed(CERT_BASE, seed, turns * 64 + i % 64, i))
        if not won:
            return i
    return n


def truth(owner, strength, turns, adj, seed):
    return sum(greedy_playout(owner, strength, turns, adj,
                              dice_seed(TRUTH_BASE, seed, turns, i))[0]
               for i in range(TRUTH_K))


def run_seed(seed, sim_seed):
    g = fastnw.new_game(seed)
    fastnw.set_topology_csr(g['n'], g['adj'])
    adj = g['adj']
    owner, strength = g['owner'].copy(), g['strength'].copy()
    mb = g['mb']
    turns = 1
    first = {}                     # variant -> its first firing position + verdict
    red_actions = 0
    while True:
        w = terminal(owner)
        if w >= 0:
            break
        pending = [k for k in list(TRIGGERS) + list(MC) if k not in first]
        if pending:
            for name in [k for k in pending if k in TRIGGERS]:
                _, _, q, spent = search(owner, strength, turns, TRIGGERS[name], sim_seed)
                if fires(q):
                    first[name] = dict(turn=turns, red=int(fastnw.counts(owner)[RED]),
                                       act=red_actions, nc=len(q), spent=spent)
            for name in [k for k in pending if k in MC]:
                n = MC[name]
                got = mc_certify(owner, strength, turns, adj, seed, n)
                if got == n:
                    first[name] = dict(turn=turns, red=int(fastnw.counts(owner)[RED]),
                                       act=red_actions, nc=0, spent=0)
            for name in first:
                if 'truth' not in first[name]:
                    first[name]['truth'] = truth(owner, strength, turns, adj, seed)
                    first[name]['truth_k'] = TRUTH_K
        # main line: the engine's own move (the strongest way to reach a won game)
        fastnw.use_sim(sim_seed)
        fastnw.set_value_stop(*VS)
        acts, visits = fastnw.uct_search(owner, strength, turns, 6000, max_sims=150000)
        fastnw.set_value_stop()
        action = -1 if len(acts) == 0 else int(acts[int(np.argmax(visits))])
        red_actions += 1
        fastnw.use_mb32(mb)
        if action < 0:
            fastnw.end_turn(owner, strength)
            turns += 1
            if turns > MAX_TURNS:
                break
        else:
            fastnw.resolve_battle(owner, strength, action >> 8, action & 0xFF)
        mb = fastnw.get_mb32()
    return dict(seed=seed, won=terminal(owner) == RED, turns=turns,
                red_actions=red_actions, first=first)


def report(paths):
    rows = []
    for p in paths:
        for pat in glob.glob(p):
            with open(pat) as f:
                rows += [json.loads(l) for l in f if l.strip()]
    if not rows:
        print('no rows'); return
    won = [r for r in rows if r['won']]
    print(f'{len(rows)} games ({len(won)} won by RED, {100*len(won)/len(rows):.0f}%)\n')
    print(f'{"variant":8s} {"fires":>12s} {"turn":>6s} {"RED":>5s} {"moves left":>11s} '
          f'{"greedy truth from the offered position":>40s}')
    for name in list(TRIGGERS) + list(MC):
        sub = [r for r in rows if name in r['first']]
        if not sub:
            print(f'{name:8s} {"0":>12s}'); continue
        f = [r['first'][name] for r in sub]
        tk = sum(x['truth_k'] for x in f)
        tw = sum(x['truth'] for x in f)
        pl = 1 - tw / tk
        se = 1.96 * math.sqrt(max(pl, 1e-9) * (1 - pl) / tk)
        left = [r['red_actions'] - x['act'] for r, x in zip(sub, f)]
        bad = sum(1 for x in f if x['truth'] < x['truth_k'])
        print(f'{name:8s} {f"{len(sub)}/{len(rows)}":>12s} '
              f'{int(np.median([x["turn"] for x in f])):>6d} '
              f'{int(np.median([x["red"] for x in f])):>5d} '
              f'{int(np.median(left)):>11d} '
              f'{f"loses {100*pl:.3f}% +-{100*se:.3f} ({bad}/{len(sub)} positions)":>40s}')
    print('\n(turn/RED/moves-left are medians at the variant\'s FIRST firing position;\n'
          ' "moves left" = RED actions the engine still needed = what a sweep saves.)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', default='1-10')
    ap.add_argument('--sim-seed', type=int, default=0x12345678)
    ap.add_argument('--out', default=None)
    ap.add_argument('--report', nargs='*', default=None)
    a = ap.parse_args()
    if a.report is not None:
        report(a.report or ['/tmp/var*.jsonl']); return
    lo, hi = (int(x) for x in a.seeds.split('-'))
    out = open(a.out, 'a', buffering=1) if a.out else sys.stdout
    for seed in range(lo, hi + 1):
        print(json.dumps(run_seed(seed, a.sim_seed)), file=out)


if __name__ == '__main__':
    main()
