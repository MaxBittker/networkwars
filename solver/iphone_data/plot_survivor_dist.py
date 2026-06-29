#!/usr/bin/env python3
"""survivor_dist.pdf — does a generative survivor model match the live DISTRIBUTION
(not just the mean)? Proposed model adds ZERO free parameters beyond the existing
fitted mean curves: each troop survives independently -> Binomial spread.

  capture occupier:  occ = 1 + Binomial(a-2, p_o),  p_o = (mu_occ-1)/(a-2)
  repel  remnant:    rem =     Binomial(d,   p_r),  p_r =  mu_rem/d
  with mu_occ = 0.82a-0.44d+0.10,  mu_rem = 0.30+0.24d+0.42*max(0,d-a)

For each margin we draw one model survivor for every real battle's (a,d) and
box-plot those draws beside the observed box. Means coincide by construction; the
question is whether the SPREAD matches. Seeded for reproducibility.

Usage:  python plot_survivor_dist.py /tmp/battles.csv
"""
import csv, sys
from collections import defaultdict
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from matplotlib.backends.backend_pdf import PdfPages

RNG = np.random.default_rng(20260629)

def mu_occ(a, d): return min(a, max(1.0, 0.82 * a - 0.44 * d + 0.10))
def mu_rem(a, d): return min(d, max(0.0, 0.30 + 0.24 * d + 0.42 * max(0, d - a)))

def draw_occ(a, d):
    n = a - 2
    if n <= 0: return 1
    p = min(1.0, max(0.0, (mu_occ(a, d) - 1) / n))
    return 1 + int(RNG.binomial(n, p))
def draw_rem(a, d):
    if d <= 0: return 0
    p = min(1.0, max(0.0, mu_rem(a, d) / d))
    return int(RNG.binomial(d, p))

# ---- load --------------------------------------------------------------------
CSV = sys.argv[1] if len(sys.argv) > 1 else '/tmp/battles.csv'
cap_obs, rep_obs, dropped = [], [], 0
with open(CSV) as f:
    for row in csv.DictReader(f):
        try: a, d = int(row['a']), int(row['d'])
        except (ValueError, KeyError): continue
        if a < 1 or d < 1: continue
        if row['outcome'] == 'capture' and row.get('atk_survivor'):
            s = int(row['atk_survivor'])
            if a >= 2 and 1 <= s <= a - 1: cap_obs.append((a, d, s))
            else: dropped += 1
        elif row['outcome'] != 'capture' and row.get('def_survivor', '') != '':
            s = int(row['def_survivor'])
            if 0 <= s <= d: rep_obs.append((a, d, s))
            else: dropped += 1

def by_margin(obs, draw_fn):
    g = defaultdict(lambda: {'obs': [], 'mod': []})
    for a, d, s in obs:
        g[a - d]['obs'].append(s)
        g[a - d]['mod'].append(draw_fn(a, d))
    ms = sorted(m for m, c in g.items() if len(c['obs']) >= 15 and -5 <= m <= 9)
    return ms, [np.array(g[m]['obs'], float) for m in ms], \
           [np.array(g[m]['mod'], float) for m in ms], [len(g[m]['obs']) for m in ms]

def tvd(obs, mod):  # weighted mean total-variation distance, per margin
    tot = w = 0.0
    for o, m in zip(obs, mod):
        eo, em = defaultdict(float), defaultdict(float)
        for x in o: eo[x] += 1 / len(o)
        for x in m: em[x] += 1 / len(m)
        d = 0.5 * sum(abs(eo.get(k, 0) - em.get(k, 0)) for k in set(eo) | set(em))
        tot += len(o) * d; w += len(o)
    return tot / w

def panel(ax, ms, obs, mod, title, ylabel):
    wid = 0.34
    bp1 = ax.boxplot(obs, positions=[m - 0.19 for m in ms], widths=wid,
                     patch_artist=True, showfliers=False, manage_ticks=False,
                     medianprops=dict(color='#1b2631', lw=1.2),
                     whiskerprops=dict(color='#566573'), capprops=dict(color='#566573'))
    bp2 = ax.boxplot(mod, positions=[m + 0.19 for m in ms], widths=wid,
                     patch_artist=True, showfliers=False, manage_ticks=False,
                     medianprops=dict(color='#0b3d2e', lw=1.2),
                     whiskerprops=dict(color='#1e8449'), capprops=dict(color='#1e8449'))
    for b in bp1['boxes']: b.set_facecolor('#bdc3c7'); b.set_alpha(0.7); b.set_edgecolor('#566573')
    for b in bp2['boxes']: b.set_facecolor('#82e0aa'); b.set_alpha(0.6); b.set_edgecolor('#1e8449')
    ax.plot(ms, [o.mean() for o in obs], 'D', ms=4, color='black', zorder=6)
    ax.plot(ms, [m.mean() for m in mod], '_', ms=10, mew=2, color='#1e8449', zorder=6)
    dmax = max(max(o.max() for o in obs), max(m.max() for m in mod))
    ax.set_ylim(-0.7, dmax + 0.8)
    ax.set_title(title, fontsize=11)
    ax.set_xlabel('strength margin  $a - d$'); ax.set_ylabel(ylabel)
    ax.grid(True, alpha=0.2, axis='y'); ax.set_xticks(ms)
    ax.legend(handles=[Patch(fc='#bdc3c7', ec='#566573', label='LIVE observed'),
                       Patch(fc='#82e0aa', ec='#1e8449', label='Binomial model (sampled)')],
              loc='upper left' if 'apture' in title else 'upper right', fontsize=8.5)

cm, c_o, c_m, c_n = by_margin(cap_obs, draw_occ)
rm, r_o, r_m, r_n = by_margin(rep_obs, draw_rem)

with PdfPages('survivor_dist.pdf') as pdf:
    fig, (axL, axR) = plt.subplots(1, 2, figsize=(13.0, 6.6))
    panel(axL, cm, c_o, c_m, f'Capture: occupier strength  (n={len(cap_obs):,})',
          'surviving troops on captured node')
    panel(axR, rm, r_o, r_m, f'Repel: defender remnant  (n={len(rep_obs):,})',
          'surviving troops on defended node')
    fig.suptitle('Matching the DISTRIBUTION, not just the mean — '
                 'live box vs zero-extra-parameter Binomial survivor model\n'
                 'occ = 1+Binom($a{-}2$, $p_o$),  rem = Binom($d$, $p_r$);  '
                 '$p$ set so the mean equals the existing fitted curve',
                 fontsize=12.0)
    fig.text(0.5, 0.005,
             f'Per-margin mean total-variation distance:  capture {tvd(c_o, c_m):.3f}   '
             f'repel {tvd(r_o, r_m):.3f}   (0 = identical distribution).  '
             f'Spread is emergent from the binomial — no spread parameter was fit.',
             ha='center', fontsize=8, color='#555')
    fig.tight_layout(rect=[0, 0.02, 1, 0.92])
    pdf.savefig(fig); plt.close(fig)

print('wrote survivor_dist.pdf')
print(f'  capture: per-margin TVD {tvd(c_o, c_m):.3f}  (n={len(cap_obs):,})')
print(f'  repel:   per-margin TVD {tvd(r_o, r_m):.3f}  (n={len(rep_obs):,})')
