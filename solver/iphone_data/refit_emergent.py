#!/usr/bin/env python3
"""Compare two ways to model P(capture | a,d) against live data:

  (A) ITERATED generative mechanic (what the engine deploys): per-round attacker
      win prob q(a,d)=a^k/(a^k + c0 d^k); capture iff defender hits 0 while a>=2.
      The EMERGENT capture prob is a DP over states. Fit (k,c0) by MLE.
  (B) SINGLE-SHOT closed form: P = a^g/(a^g + c d^g). Fit (g,c) by MLE.

Reports best params, log-lik/AIC, and calibration-by-margin for each, plus the
currently-shipped iterated k=0.62,c0=0.93.

Usage: python refit_emergent.py /tmp/all_battles.csv
"""
import sys, csv, math
from functools import lru_cache
import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/all_battles.csv'
A, D, Y = [], [], []
with open(path) as f:
    for r in csv.DictReader(f):
        try:
            a = int(r['a']); d = int(r['d'])
        except (ValueError, TypeError):
            continue
        if a < 1 or d < 1:
            continue
        A.append(a); D.append(d); Y.append(1 if r['outcome'] == 'capture' else 0)
A = np.array(A); D = np.array(D); Y = np.array(Y, float)
N = len(Y)

# unique (a,d) cells with capture counts — fit on the compressed table (fast)
from collections import defaultdict
cell = defaultdict(lambda: [0, 0])   # (a,d) -> [caps, n]
for a, d, y in zip(A, D, Y):
    cell[(int(a), int(d))][0] += y
    cell[(int(a), int(d))][1] += 1
cells = [(a, d, c, n) for (a, d), (c, n) in cell.items()]


def emergent_pcap(k, c0, amax=40, dmax=40):
    """DP capture prob for iterated mechanic, memoized per (k,c0)."""
    @lru_cache(maxsize=None)
    def f(a, d):
        if d == 0:
            return 1.0 if a >= 2 else 0.0
        if a <= 1:
            return 0.0
        ak = a**k; dk = d**k
        q = ak / (ak + c0*dk)
        return q*f(a, d-1) + (1-q)*f(a-1, d)
    return f


def nll_iterated(k, c0):
    f = emergent_pcap(k, c0)
    ll = 0.0
    for a, d, c, n in cells:
        p = min(max(f(a, d), 1e-12), 1-1e-12)
        ll += c*math.log(p) + (n-c)*math.log(1-p)
    return -ll


def nll_single(g, c):
    ll = 0.0
    for a, d, cc, n in cells:
        ak = a**g; dk = d**g
        p = ak/(ak + c*dk)
        p = min(max(p, 1e-12), 1-1e-12)
        ll += cc*math.log(p) + (n-cc)*math.log(1-p)
    return -ll


def grid_min(nll, p1_range, p2_range, refine=4):
    best = None
    r1, r2 = p1_range, p2_range
    for _ in range(refine):
        g1 = np.linspace(*r1, 25); g2 = np.linspace(*r2, 25)
        best = None
        for x in g1:
            for yv in g2:
                v = nll(x, yv)
                if best is None or v < best[0]:
                    best = (v, x, yv)
        _, bx, by = best
        s1 = (r1[1]-r1[0])/8; s2 = (r2[1]-r2[0])/8
        r1 = (bx-s1, bx+s1); r2 = (by-s2, by+s2)
    return best  # (nll, p1, p2)

print(f'N = {N} battles, {len(cells)} distinct (a,d) cells\n')

# (A) iterated emergent fit
vA, kA, cA = grid_min(nll_iterated, (0.4, 1.6), (0.6, 1.4))
aicA = 2*2 + 2*vA
# (B) single-shot fit
vB, gB, cB = grid_min(nll_single, (2.0, 5.0), (0.8, 2.0))
aicB = 2*2 + 2*vB
# shipped iterated
vS = nll_iterated(0.62, 0.93); aicS = 2*2 + 2*vS

print('=== model comparison (2 params each) ===')
print(f'{"model":<40}{"logLik":>11}{"AIC":>10}')
print(f'{"SHIPPED iterated k=0.62 c0=0.93":<40}{-vS:>11.1f}{aicS:>10.1f}')
print(f'{"REFIT iterated k=%.3f c0=%.3f"%(kA,cA):<40}{-vA:>11.1f}{aicA:>10.1f}')
print(f'{"REFIT single-shot g=%.3f c=%.3f"%(gB,cB):<40}{-vB:>11.1f}{aicB:>10.1f}')

# calibration by margin
fS = emergent_pcap(0.62, 0.93)
fA = emergent_pcap(kA, cA)
print('\n=== calibration by margin (obs vs shipped-iter vs refit-iter vs single) ===')
print(f'{"a-d":>5}{"n":>6}{"obs%":>8}{"ship%":>8}{"iter*%":>8}{"sing*%":>8}')
bm = defaultdict(lambda: [0, 0, 0.0, 0.0, 0.0])  # margin -> [caps,n,sumship,sumiter,sumsingle]
for a, d, c, n in cells:
    m = a - d
    e = bm[m]
    e[0] += c; e[1] += n
    e[2] += fS(a, d)*n
    e[3] += fA(a, d)*n
    e[4] += (a**gB/(a**gB+cB*d**gB))*n
for m in sorted(bm):
    c, n, ss, si, sg = bm[m]
    if n < 10:
        continue
    print(f'{m:>5}{int(n):>6}{c/n*100:>8.1f}{ss/n*100:>8.1f}{si/n*100:>8.1f}{sg/n*100:>8.1f}')
