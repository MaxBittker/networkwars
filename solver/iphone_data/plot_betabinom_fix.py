#!/usr/bin/env python3
"""betabinom_fix.pdf — the capture-occupier overdispersion fix (BATTLE_FUNCTION §8).

The occupier mean is right under both models, but a plain Binomial UNDER-predicts
the spread (17/28 cells overdispersed). A beta-binomial with one intra-class
correlation rho (MLE 0.21) fixes it — mean unchanged, variance inflated by
1+(n-1)*rho. Two views:

  LEFT  calibration: predicted vs observed per-cell std. Binomial sits BELOW the
        y=x line (too tight); beta-binomial sits ON it.
  RIGHT distribution: 3 representative cells, live histogram vs the two model pmfs —
        the binomial is too peaked, the beta-binomial matches the live width.

Usage:  python plot_betabinom_fix.py /tmp/battles.csv
"""
import csv, sys
from collections import defaultdict
from math import comb, lgamma, exp, log
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

RHO = 0.21
def mean_occ(a, d): return min(a - 1, max(1.0, 0.82 * a - 0.44 * d + 0.10))

def binom_pmf(n, p):
    return {k: comb(n, k) * p**k * (1 - p)**(n - k) for k in range(n + 1)}
def betabinom_pmf(n, p, rho):
    if rho <= 1e-9: return binom_pmf(n, p)
    M = (1 - rho) / rho; a, b = p * M, (1 - p) * M
    lb = lambda x, y: lgamma(x) + lgamma(y) - lgamma(x + y)
    return {k: exp(log(comb(n, k)) + lb(k + a, n - k + b) - lb(a, b)) for k in range(n + 1)}
def pmf_std(pmf):
    ks = np.array(list(pmf.keys()), float); ps = np.array(list(pmf.values()))
    mu = (ks * ps).sum(); return ((ks - mu) ** 2 * ps).sum() ** 0.5

# ---- load capture occupier cells ----
CSV = sys.argv[1] if len(sys.argv) > 1 else '/tmp/battles.csv'
cap = defaultdict(list)
for r in csv.DictReader(open(CSV)):
    try: a, d = int(r['a']), int(r['d'])
    except (ValueError, KeyError): continue
    if a < 1 or d < 1: continue
    if r['outcome'] == 'capture' and r.get('atk_survivor'):
        s = int(r['atk_survivor'])
        if a >= 2 and 1 <= s <= a - 1: cap[(a, d)].append(s)

# per-cell observed vs predicted std (need n=a-2>=2 for overdispersion to act)
pts = []  # (obs_std, binom_std, bb_std, n, a, d)
for (a, d), v in cap.items():
    n = a - 2
    if n < 2 or len(v) < 30: continue
    p = min(1, max(0, (mean_occ(a, d) - 1) / n))
    occ_k = [s - 1 for s in v]
    pts.append((np.std(occ_k), pmf_std(binom_pmf(n, p)), pmf_std(betabinom_pmf(n, p, RHO)),
                len(v), a, d))

obs = np.array([x[0] for x in pts]); bn = np.array([x[1] for x in pts])
bb = np.array([x[2] for x in pts]); ns = np.array([x[3] for x in pts])
# RMSE of predicted-vs-observed std, sample-weighted
wrmse = lambda pred: (np.sum(ns * (pred - obs) ** 2) / ns.sum()) ** 0.5

from matplotlib.lines import Line2D
with PdfPages('betabinom_fix.pdf') as pdf:
    fig = plt.figure(figsize=(13.5, 6.4))
    gs = fig.add_gridspec(3, 2, width_ratios=[1.05, 1.0], hspace=0.55, wspace=0.22)
    axL = fig.add_subplot(gs[:, 0])

    # -------- LEFT: std calibration --------
    lim = max(obs.max(), bb.max()) + 0.2
    axL.plot([0, lim], [0, lim], '--', color='#888', lw=1, label='perfect (y=x)')
    axL.scatter(obs, bn, s=12 + ns / 10, color='#c0392b', alpha=0.75,
                label=f'Binomial  (std RMSE {wrmse(bn):.3f})')
    axL.scatter(obs, bb, s=12 + ns / 10, color='#27ae60', alpha=0.8,
                label=f'Beta-binomial ρ={RHO}  (std RMSE {wrmse(bb):.3f})')
    axL.set_xlabel('observed per-cell std of occupier (troops)')
    axL.set_ylabel('model-predicted std (troops)')
    axL.set_title(f'Spread calibration, {len(pts)} capture cells (n≥30, a≥4)\n'
                  'Binomial sits BELOW y=x (too tight); beta-binomial lands on it',
                  fontsize=10.5)
    axL.set_xlim(0, lim); axL.set_ylim(0, lim); axL.set_aspect('equal')
    axL.grid(True, alpha=0.25); axL.legend(loc='upper left', fontsize=9)

    # -------- RIGHT: 3 representative cells, each its own panel --------
    # pick wide-support, well-sampled cells (a>=6 -> support spans >=5) to show spread
    wide = sorted([pt for pt in pts if pt[4] >= 6], key=lambda x: -x[3])[:3]
    for row, (_, _, _, n_, a, d) in enumerate(wide):
        ax = fig.add_subplot(gs[row, 1])
        v = cap[(a, d)]; nn = a - 2
        p = min(1, max(0, (mean_occ(a, d) - 1) / nn))
        emp = defaultdict(float)
        for s in v: emp[s] += 1 / len(v)
        ks = list(range(1, a))
        ax.bar(ks, [100 * emp.get(k, 0) for k in ks], width=0.7, color='#bdc3c7',
               edgecolor='#7f8c8d', label='live')
        bnp = binom_pmf(nn, p); bbp = betabinom_pmf(nn, p, RHO)
        ax.plot(ks, [100 * bnp.get(k - 1, 0) for k in ks], 'o:', color='#c0392b', ms=4, lw=1.3)
        ax.plot(ks, [100 * bbp.get(k - 1, 0) for k in ks], 's-', color='#27ae60', ms=4, lw=1.8)
        ax.set_title(f'a={a}, d={d}  (n={n_}, mean={mean_occ(a,d):.2f})', fontsize=9.5)
        ax.grid(True, alpha=0.2, axis='y'); ax.set_ylabel('%', fontsize=8)
        ax.tick_params(labelsize=8)
        if row == len(wide) - 1:
            ax.set_xlabel('occupier strength on captured node', fontsize=9)
        if row == 0:
            ax.legend([Line2D([], [], color='#bdc3c7', lw=6),
                       Line2D([], [], color='#c0392b', marker='o', ls=':'),
                       Line2D([], [], color='#27ae60', marker='s', ls='-')],
                      ['live', 'Binomial (too peaked)', f'Beta-binomial ρ={RHO}'],
                      fontsize=8, loc='upper left')

    fig.suptitle('Capture-occupier overdispersion fix: beta-binomial (ρ=0.21) vs plain '
                 'binomial\nMean UNCHANGED (win-rate unaffected) — only the spread is '
                 'corrected to match the data', fontsize=11.5)
    fig.tight_layout(rect=[0, 0, 1, 0.94])
    pdf.savefig(fig); plt.close(fig)

print('wrote betabinom_fix.pdf')
print(f'  std RMSE across {len(pts)} cells:  binomial {wrmse(bn):.3f}  ->  '
      f'beta-binomial {wrmse(bb):.3f} troops')
