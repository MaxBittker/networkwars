"""End-to-end check of the proposed sweep-up: a Monte-Carlo certificate of the mop-up
policy as the gate, re-certified before EVERY swept action, handing the game back to
the human the moment it fails.

sweep_variants.py measured the gate alone (mc1000: 0.070% loss vs the shipped
q-gate's 6.1%). This measures the shipped shape, where the sweep can also bail out
mid-mop-up. Reported per accepted offer: won / handed back / LOST.

    uv run python sweep_final.py --seeds 1-40 --out /tmp/fin.jsonl
    uv run python sweep_final.py --report '/tmp/fin_*.jsonl'
"""
import argparse
import ctypes
import glob
import json
import sys

import numpy as np

import fastnw
from sweep_audit import RED, MAX_TURNS, VS, terminal

_L = fastnw._lib
_L.sweep_certify.argtypes = [fastnw._i32p, fastnw._i32p, ctypes.c_int, ctypes.c_int,
                             ctypes.c_int]
_L.sweep_certify.restype = ctypes.c_int
_L.sweep_best_move.argtypes = [fastnw._i32p, fastnw._i32p]
_L.sweep_best_move.restype = ctypes.c_int

TRIALS = 1000              # gate: 1000 clean playouts to OFFER the sweep
RECHECK = 400              # cheaper re-check before each swept action
BARS = [None, 0, 2, 4]     # max losses per RECHECK tolerated to stay in the sweep
K = 200                    # sweeps measured per offered position


def certify(owner, strength, turns, trials=TRIALS, max_losses=0):
    return _L.sweep_certify(fastnw._p(owner), fastnw._p(strength), turns,
                            trials, max_losses) <= max_losses


def sweep_next(owner, strength):
    mv = _L.sweep_best_move(fastnw._p(owner), fastnw._p(strength))
    return None if mv < 0 else (mv >> 8, mv & 0xFF)


def run_sweep(owner0, strength0, turns, mb_seed, bar):
    """Play the mop-up on fresh dice, re-checking before every action and handing
    back if it fails (bar = max losses per RECHECK; None = never re-check, the
    shipped behaviour). Returns 'won' | 'back' | 'lost'."""
    owner, strength = owner0.copy(), strength0.copy()
    mb = mb_seed & 0xFFFFFFFF
    for _ in range(4000):
        w = terminal(owner)
        if w >= 0:
            return 'won' if w == RED else 'lost'
        if bar is not None and not certify(owner, strength, turns, RECHECK, bar):
            return 'back'
        m = sweep_next(owner, strength)
        fastnw.use_mb32(mb)
        if m is not None:
            fastnw.resolve_battle(owner, strength, m[0], m[1])
        else:
            fastnw.end_turn(owner, strength)
            turns += 1
            if turns > MAX_TURNS:
                return 'lost'
        mb = fastnw.get_mb32()
    return 'lost'


def run_seed(seed, sim_seed):
    g = fastnw.new_game(seed)
    fastnw.set_topology_csr(g['n'], g['adj'])
    owner, strength = g['owner'].copy(), g['strength'].copy()
    mb = g['mb']
    turns = 1
    acts = 0
    while terminal(owner) < 0:
        if certify(owner, strength, turns):
            res = {str(b): {'won': 0, 'back': 0, 'lost': 0} for b in BARS}
            for i in range(K):
                ds = (0x60000000 + seed * 7919 + turns * 1000003 + i * 104729) & 0xFFFFFFFF
                for b in BARS:
                    res[str(b)][run_sweep(owner, strength, turns, ds, b)] += 1
            return dict(seed=seed, turn=turns, red=int(fastnw.counts(owner)[RED]),
                        act=acts, k=K, bars=res)
        fastnw.use_sim(sim_seed)
        fastnw.set_value_stop(*VS)
        a, v = fastnw.uct_search(owner, strength, turns, 6000, max_sims=150000)
        fastnw.set_value_stop()
        action = -1 if len(a) == 0 else int(a[int(np.argmax(v))])
        acts += 1
        fastnw.use_mb32(mb)
        if action < 0:
            fastnw.end_turn(owner, strength)
            turns += 1
            if turns > MAX_TURNS:
                break
        else:
            fastnw.resolve_battle(owner, strength, action >> 8, action & 0xFF)
        mb = fastnw.get_mb32()
    return dict(seed=seed, turn=turns, offered=False)


def report(paths):
    rows = []
    for p in paths:
        for pat in glob.glob(p):
            with open(pat) as f:
                rows += [json.loads(l) for l in f if l.strip()]
    off = [r for r in rows if r.get('bars')]
    print(f'{len(rows)} games, {len(off)} offered a sweep '
          f'(certificate {TRIALS}/{TRIALS} wins)\n')
    if not off:
        return
    n = sum(r['k'] for r in off)
    for b in BARS:
        label = ('gate only, no re-check' if b is None
                 else f're-check {RECHECK}, bail if >{b} lose')
        t = {k: sum(r['bars'][str(b)][k] for r in off) for k in ('won', 'back', 'lost')}
        print(f'{label:30s} won {t["won"]:5d}  handed back {t["back"]:5d}  '
              f'LOST {t["lost"]:4d}   ({100*t["lost"]/n:.3f}% of {n} sweeps)')
    print(f'\noffered at turn median {int(np.median([r["turn"] for r in off]))}, '
          f'RED nodes median {int(np.median([r["red"] for r in off]))}')
    bad = [r for r in off if r['bars'][str(BARS[-1])]['lost'] or r['bars']['None']['lost']]
    for r in sorted(bad, key=lambda r: -r['bars']['None']['lost'])[:10]:
        print(f'  seed {r["seed"]:5d} turn {r["turn"]:3d} red={r["red"]:2d} losses/'
              f'{r["k"]} by bar: ' + ' '.join(f'{b}={r["bars"][str(b)]["lost"]}' for b in BARS))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', default='1-10')
    ap.add_argument('--sim-seed', type=int, default=0x12345678)
    ap.add_argument('--out', default=None)
    ap.add_argument('--report', nargs='*', default=None)
    a = ap.parse_args()
    if a.report is not None:
        report(a.report or ['/tmp/fin*.jsonl']); return
    lo, hi = (int(x) for x in a.seeds.split('-'))
    out = open(a.out, 'a', buffering=1) if a.out else sys.stdout
    for seed in range(lo, hi + 1):
        print(json.dumps(run_seed(seed, a.sim_seed)), file=out)


if __name__ == '__main__':
    main()
