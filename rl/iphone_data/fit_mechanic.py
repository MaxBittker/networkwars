#!/usr/bin/env python3
"""Fit a GENERATIVE battle mechanic to outcomes AND survivors jointly.

The outcome-level fit (fit_battle.py) says P(capture) ~ power-ratio a^g/(a^g+c d^g),
g~3.2. But survivors have attrition spread, so the true mechanic is iterated, not
single-shot. Candidate generative process: STRENGTH-PROPORTIONAL per-round dice.

  state (a, d), a>=1, d>=0.  Each round:
    attacker wins w.p.  q(a,d) = a^k / (a^k + c0 * d^k)   -> d -= 1
    else                                                  -> a -= 1
  absorbing: d==0 -> CAPTURE (node gets a-1 troops, source keeps 1)
             a==1 -> REPEL   (defender keeps remaining d)

k=1, c0=1 is "roll proportional to current strength". Larger k -> steeper (more
deterministic) per round. This single (k,c0) should reproduce BOTH:
  (1) the overall P(capture|a0,d0) curve (compare to observed + to power-ratio), and
  (2) the survivor distributions (attacker remnant on capture, defender on repel).

Compares against the shipped CONSTANT-p ruin (k=0 => q=const) as baseline.

Usage: python fit_mechanic.py /tmp/all_battles.csv
"""
import csv, sys
import numpy as np
from functools import lru_cache


def make_solver(k, c0):
    """Return P_capture(a,d) and E[survivor] under strength-proportional dice."""
    @lru_cache(maxsize=None)
    def q(a, d):
        if d <= 0:
            return 1.0
        if a <= 1:
            return 0.0
        ak, dk = a ** k, d ** k
        return ak / (ak + c0 * dk)

    @lru_cache(maxsize=None)
    def Pcap(a, d):
        if a <= 1:
            return 0.0
        if d <= 0:
            return 1.0
        qq = q(a, d)
        return qq * Pcap(a, d - 1) + (1 - qq) * Pcap(a - 1, d)

    # expected attacker remnant ON CAPTURE (conditioned on capture path), and
    # expected defender remnant ON REPEL. Solve via DP over absorbing remnants.
    @lru_cache(maxsize=None)
    def E_atk_on_cap(a, d):
        # returns (P_capture, E[a_final-1 | capture]*P_capture) accumulator form
        if d <= 0:
            return (1.0, float(a - 1))      # captured now; node gets a-1
        if a <= 1:
            return (0.0, 0.0)
        qq = q(a, d)
        p1, s1 = E_atk_on_cap(a, d - 1)
        p2, s2 = E_atk_on_cap(a - 1, d)
        return (qq * p1 + (1 - qq) * p2, qq * s1 + (1 - qq) * s2)

    @lru_cache(maxsize=None)
    def E_def_on_rep(a, d):
        if d <= 0:
            return (0.0, 0.0)              # captured, no repel
        if a <= 1:
            return (1.0, float(d))         # repelled now; defender keeps d
        qq = q(a, d)
        p1, s1 = E_def_on_rep(a, d - 1)
        p2, s2 = E_def_on_rep(a - 1, d)
        return (qq * p1 + (1 - qq) * p2, qq * s1 + (1 - qq) * s2)

    return Pcap, E_atk_on_cap, E_def_on_rep


def load(path):
    rows = []
    for r in csv.DictReader(open(path)):
        try:
            a, d = int(r['a']), int(r['d'])
        except (ValueError, KeyError):
            continue
        if a <= 0 or d <= 0:
            continue
        rows.append((a, d, r['outcome'] == 'capture',
                     _i(r.get('atk_survivor')), _i(r.get('def_survivor'))))
    return rows


def _i(s):
    try:
        return int(s)
    except (ValueError, TypeError):
        return None


def nll_outcomes(rows, Pcap):
    eps = 1e-9
    s = 0.0
    for a, d, cap, *_ in rows:
        p = min(max(Pcap(a, d), eps), 1 - eps)
        s -= np.log(p) if cap else np.log(1 - p)
    return s


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/all_battles.csv'
    rows = load(path)
    print(f'loaded {len(rows)} battles from {path}\n')

    # --- fit (k, c0) by MLE on outcomes (grid + zoom) ---
    def fit_nll(k, c0):
        Pcap, *_ = make_solver(round(k, 3), round(c0, 3))
        return nll_outcomes(rows, Pcap)

    lo_k, hi_k, lo_c, hi_c = 0.3, 4.0, 0.4, 3.0
    best = None
    for _ in range(4):
        for k in np.linspace(lo_k, hi_k, 22):
            for c0 in np.linspace(lo_c, hi_c, 22):
                v = fit_nll(k, c0)
                if best is None or v < best[0]:
                    best = (v, k, c0)
        _, bk, bc = best
        dk = (hi_k - lo_k) / 22; dc = (hi_c - lo_c) / 22
        lo_k, hi_k = bk - dk, bk + dk; lo_c, hi_c = bc - dc, bc + dc
    bnll, bk, bc = best
    print(f'=== strength-proportional dice fit (MLE on outcomes) ===')
    print(f'  k={bk:.3f}  c0={bc:.3f}   nll={bnll:.2f}  AIC={2*2+2*bnll:.1f}')

    # shipped constant-p baseline (k=0)
    def const_solver(p):
        @lru_cache(maxsize=None)
        def Pc(a, d):
            if a <= 1: return 0.0
            if d <= 0: return 1.0
            return p * Pc(a, d - 1) + (1 - p) * Pc(a - 1, d)
        return Pc
    bestp = min(np.linspace(0.45, 0.8, 71), key=lambda p: nll_outcomes(rows, const_solver(p)))
    cnll = nll_outcomes(rows, const_solver(bestp))
    print(f'  baseline const-p ruin: p={bestp:.3f}  nll={cnll:.2f}  AIC={2*1+2*cnll:.1f}')

    # --- validate survivors under the fitted mechanic ---
    Pcap, Eatk, Edef = make_solver(round(bk, 3), round(bc, 3))
    caps = [(a, d, s) for a, d, c, s, _ in rows if c and s is not None]
    reps = [(a, d, s) for a, d, c, _, s in rows if (not c) and s is not None]
    print(f'\n=== survivor validation (model E[.] vs observed mean) ===')
    if caps:
        obs = np.array([s for *_, s in caps], float)
        pred = np.array([Eatk(a, d)[1] / max(Eatk(a, d)[0], 1e-9) for a, d, _ in caps])
        print(f'CAPTURE remnant (n={len(caps)}): obs mean={obs.mean():.2f}  '
              f'model mean={pred.mean():.2f}  MAE={np.abs(obs-pred).mean():.2f}')
    if reps:
        obs = np.array([s for *_, s in reps], float)
        pred = np.array([Edef(a, d)[1] / max(Edef(a, d)[0], 1e-9) for a, d, _ in reps])
        print(f'REPEL  remnant (n={len(reps)}): obs mean={obs.mean():.2f}  '
              f'model mean={pred.mean():.2f}  MAE={np.abs(obs-pred).mean():.2f}')

    # --- capture curve by margin: observed vs fitted mechanic vs const-p ---
    from collections import defaultdict
    b = defaultdict(lambda: [0, 0, 0.0, 0.0])
    Pc0 = const_solver(bestp)
    for a, d, cap, *_ in rows:
        m = max(-3, min(4, a - d))
        b[m][0] += cap; b[m][1] += 1
        b[m][2] += Pcap(a, d); b[m][3] += Pc0(a, d)
    print(f'\n=== capture rate by margin: obs vs strength-prop vs const-p({bestp:.2f}) ===')
    print(f'{"a-d":>5}{"n":>6}{"obs%":>8}{"sprop%":>9}{"const%":>9}')
    for k in sorted(b):
        c, t, sp, cp = b[k]
        print(f'{k:>+5}{t:>6}{c/t*100:>7.0f}{sp/t*100:>8.0f}{cp/t*100:>8.0f}')


if __name__ == '__main__':
    main()
