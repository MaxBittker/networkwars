#!/usr/bin/env python3
"""Render a multi-page PDF comparing, on the live battle data:
  - DATA            : 12,670 ground-truth iOS battles (per-(a,d) cells)
  - CLOSED FORM     : the SHIPPED model -- single-shot P=a^3.40/(a^3.40+1.26 d^3.40)
                      + beta-binomial occupier / binomial remnant around fitted planes
  - PLAUSIBLE LOOP  : the best historically-plausible ITERATED loop (improved idea B,
                      the asymmetric ratio-sensitive volley):
                         while a>1 and d>0:
                             if rng() < a/(a+d): d -= 1   # attacker wins an exchange
                             if rng() < 0.34:    a -= 1   # a defender returns fire
                         capture iff d==0 (occ=a-1); else repel (rem=d)
                      ONE loop produces both outcome AND survivors emergently.

Figures show every quality we care about: who-wins by margin and by ratio
(ratio-sensitivity), occupier & remnant survivor means vs size, the survivor
DISTRIBUTIONS (spread, not just mean), and per-cell calibration.

Usage: python make_battle_pdf.py /tmp/all_battles.csv [out.pdf]
"""
import sys, csv, math
from collections import defaultdict
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

CSV = sys.argv[1] if len(sys.argv) > 1 else '/tmp/all_battles.csv'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/Users/max/repos/network-wars/solver/battle_model_comparison.pdf'

# ---------- closed-form (SHIPPED) params ----------
G, C = 3.40, 1.26
RHO = 0.21
def cf_pcap(a, d):    return a**G / (a**G + C * d**G)
def mu_occ(a, d):     return min(max(0.82*a - 0.44*d + 0.10, 1.0), max(1.0, a-1))
def mu_rem(a, d):     return min(max(0.30 + 0.24*d + 0.42*max(0, d-a), 0.0), float(d))

# ---------- best-fit HYBRID loop, from ../iterated_battle.py ----------
# WIN + OCCUPIER come from the lethal+rout play-out; the repel REMNANT is a decoupled
# hinge draw (the play-out cannot produce it -- depletion-repels self-select for low
# damage, and the real loss scales with d). See ../ITERATED_BATTLE_MODELS.md.
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import iterated_battle as IB
_PF = IB.loop_dp()                         # (pcap, occ_dict, rem_dict), UNconditional masses
def _norm(dct):
    z = sum(dct.values()) or 1.0
    return {k: v/z for k, v in dct.items()}
# HYBRID: outcome + occupier come from the play-out loop (where it is excellent);
# the REPEL REMNANT is DECOUPLED -- drawn from the documented 'assault guts the
# defender' hinge  rem ~ Binomial(d, mu_rem/d),  mu_rem = 0.30+0.24d+0.42*max(0,d-a).
# The play-out cannot produce the remnant (depletion-repels self-select for low
# damage, and the real loss scales with d), so we give it its own (a,d) model.
def pl_pcap(a, d):  return _PF(a, d)[0]
def pl_mocc(a, d):
    od = _norm(_PF(a, d)[1]); return sum(k*p for k, p in od.items())
def pl_mrem(a, d):  return mu_rem(a, d)                       # decoupled hinge (= closed form)
def pl_occ_pmf(a, d, kmax):
    od = _norm(_PF(a, d)[1]); return np.array([od.get(k, 0.0) for k in range(kmax+1)])
def pl_rem_pmf(a, d, kmax):
    p = min(max(mu_rem(a, d)/d, 0.0), 1.0)
    return np.array([math.comb(d, k)*p**k*(1-p)**(d-k) if k <= d else 0.0
                     for k in range(kmax+1)])

# ---------- closed-form survivor sampling ----------
_rng = np.random.default_rng(7)
def cf_occ_samples(a, d, n=40000):
    if a <= 2:  return np.ones(n, int)                  # occ pinned to 1
    mo = mu_occ(a, d); p = (mo - 1)/(a - 2); p = min(max(p, 1e-6), 1-1e-6)
    s = (1-RHO)/RHO; al = p*s; be = (1-p)*s             # beta-binomial via Beta draw
    pp = _rng.beta(al, be, n)
    return 1 + _rng.binomial(a-2, pp)
def cf_rem_samples(a, d, n=40000):
    mr = mu_rem(a, d); p = min(max(mr/d, 0.0), 1.0)
    return _rng.binomial(d, p, n)

# ---------- load data ----------
cell = defaultdict(lambda: [0, 0])
occ_s = defaultdict(list); rem_s = defaultdict(list)
for r in csv.DictReader(open(CSV)):
    try: a = int(r['a']); d = int(r['d'])
    except (ValueError, TypeError): continue
    if a < 2 or d < 1: continue
    cap = (r['outcome'] == 'capture')
    cell[(a, d)][0] += cap; cell[(a, d)][1] += 1
    if cap and r['atk_survivor']:
        o = int(r['atk_survivor'])
        if 1 <= o <= a-1: occ_s[(a, d)].append(o)
    elif (not cap) and r['def_survivor']:
        v = int(r['def_survivor'])
        if 0 <= v <= d: rem_s[(a, d)].append(v)
cells = [(a, d, c, n) for (a, d), (c, n) in cell.items()]
Ntot = sum(n for *_, n in cells)

# ---------- summary stats ----------
def aic_cap(pf):
    nll = 0.0
    for a, d, c, n in cells:
        p = min(max(pf(a, d), 1e-12), 1-1e-12)
        nll += c*math.log(p) + (n-c)*math.log(1-p)
    return -2*nll  # +2k added per-model in the table text
def occ_rmse(meanf):
    se=w=0.0
    for k, v in occ_s.items():
        if len(v) < 20: continue
        se += len(v)*(np.mean(v)-meanf(*k))**2; w += len(v)
    return math.sqrt(se/w)
def rem_rmse(meanf):
    se=w=0.0
    for k, v in rem_s.items():
        if len(v) < 20: continue
        se += len(v)*(np.mean(v)-meanf(*k))**2; w += len(v)
    return math.sqrt(se/w)

cf_aic = aic_cap(cf_pcap) + 2*2
pl_aic = aic_cap(pl_pcap) + 2*2
CF = dict(color='#1f77b4', label='Closed form (shipped)')
PL = dict(color='#d62728', label='Hybrid loop (lethal+rout, hinge remnant)')
DT = dict(color='black', label='Live data')

pdf = PdfPages(OUT)

# ===================== PAGE 1 : title + summary =====================
fig = plt.figure(figsize=(11, 8.5)); fig.patch.set_facecolor('white')
fig.text(0.5, 0.93, 'Network Wars — battle model comparison', ha='center', size=20, weight='bold')
fig.text(0.5, 0.89, f'{Ntot:,} ground-truth live iOS battles   ·   closed-form (shipped) vs best-fit hybrid loop',
         ha='center', size=11, color='#444')
txt = (
 "MODELS\n"
 "  Live data        12,670 single-battle observations (a attacker vs d defender), per-(a,d) capture rate + survivor counts.\n\n"
 "  Closed form      SHIPPED engine. Outcome is ONE Bernoulli draw:  P(capture) = a^3.40 / (a^3.40 + 1.26 d^3.40).\n"
 "  (3 separate        Survivors are SEPARATE fitted draws: occupier = 1 + BetaBinomial(a-2; mean 0.82a-0.44d+0.1, rho=0.21);\n"
 "   sub-models)       remnant = Binomial(d; mean 0.30+0.24d+0.42*max(0,d-a)).\n\n"
 "  Hybrid loop      A LETHAL-attacker play-out gives the WIN and the OCCUPIER; the repel REMNANT is a DECOUPLED draw\n"
 "  (1 loop +          (the play-out cannot make it -- depletion-repels self-select for low damage, and the real loss\n"
 "   1 remnant rule)   scales with d). Best model found by FULL joint likelihood (outcome + every survivor count):\n"
 "                         while a > 1 and d > 0:\n"
 "                             if rng() < 0.50: d -= 1                       # attacker volley lands (lethal)\n"
 "                             if rng() < 0.28: a -= 1                       # defender volley lands\n"
 "                             elif rng() < 0.05·d^0.53/(d^0.53+4.98·a^0.53): repelled = True; break   # attacker routs\n"
 "                         if d==0:  capture,  occupier = a-1  (source keeps 1)\n"
 "                         else:     repel,    remnant  = Binomial(d, mu/d),  mu = 0.30+0.24d+0.42*max(0,d-a)\n\n"
 "FIT SUMMARY (lower is better)\n"
 f"                         outcome AIC        occupier-mean RMSE        remnant-mean RMSE\n"
 f"  Closed form            {cf_aic:8.0f}              {occ_rmse(mu_occ):.3f}                     {rem_rmse(mu_rem):.3f}\n"
 f"  Hybrid loop            {pl_aic:8.0f}              {occ_rmse(pl_mocc):.3f}                     {rem_rmse(pl_mrem):.3f}\n"
 "  (on the FULL joint likelihood the hybrid is the BEST of the three: +1729 nats over the noise floor,\n"
 "   vs pure loop +1988 and closed form +2342 -- it pairs the loop's better occupier with the hinge remnant.)\n\n"
 "READING THE FIGURES\n"
 "  p2 who-wins by margin + residual · p3 ratio-sensitivity · p4 occupier survivors · p5 remnant survivors\n"
 "  p6 survivor DISTRIBUTIONS (spread, not just mean) · p7 per-cell calibration.\n\n"
 "TAKEAWAY  The play-out loop matches the occupier survivors BETTER than the closed form and tracks the win curve,\n"
 "  but it structurally cannot produce the repel remnant: a depletion-repel is exactly the case where the attacker\n"
 "  killed few defenders (conditioning), and the real loss scales with the defender's size d. So the remnant is given\n"
 "  its own decoupled (a,d) draw -- the documented 'assault guts the defender' hinge, now shared with the closed form\n"
 "  (p5/p6: the two curves coincide). One iterated mechanism for WIN+occupier, one line for the remnant; the result\n"
 "  is the best-fitting model overall. Residual honesty: the loop's win curve is still a touch generous to underdogs\n"
 "  (p2 right, lower-left) -- the price of one mechanism doing outcome and occupier together."
)
fig.text(0.06, 0.80, txt, ha='left', va='top', size=9.3, family='monospace')
pdf.savefig(fig); plt.close(fig)

# ===================== PAGE 2 : capture by margin & by ratio =====================
fig, axes = plt.subplots(1, 2, figsize=(11, 8.5)); fig.suptitle('Who wins  (capture probability)', size=15, weight='bold')
# --- by margin ---
ax = axes[0]
bm = defaultdict(lambda: [0, 0, 0.0, 0.0])
for a, d, c, n in cells:
    e = bm[a-d]; e[0]+=c; e[1]+=n; e[2]+=cf_pcap(a,d)*n; e[3]+=pl_pcap(a,d)*n
ms = sorted(m for m in bm if bm[m][1] >= 20)
obs=[bm[m][0]/bm[m][1] for m in ms]; err=[math.sqrt(o*(1-o)/bm[m][1]) for o,m in zip(obs,ms)]
ax.errorbar(ms, obs, yerr=err, fmt='o', ms=5, capsize=2, **DT, zorder=3)
ax.plot(ms, [bm[m][2]/bm[m][1] for m in ms], '-', lw=2, **CF)
ax.plot(ms, [bm[m][3]/bm[m][1] for m in ms], '--', lw=2, **PL)
ax.set_xlabel('strength margin  a − d'); ax.set_ylabel('P(capture)'); ax.set_title('by margin')
ax.grid(alpha=.3); ax.legend(); ax.set_ylim(-0.03, 1.03)
# --- residual: model − observed, by margin (where does each model miss?) ---
ax = axes[1]
se = [math.sqrt(o*(1-o)/bm[m][1]) for o, m in zip([bm[m][0]/bm[m][1] for m in ms], ms)]
ax.fill_between(ms, [-s for s in se], se, color='gray', alpha=.25, label='data ±1 SE')
ax.plot(ms, [bm[m][2]/bm[m][1]-bm[m][0]/bm[m][1] for m in ms], '-o', ms=4, lw=2, **CF)
ax.plot(ms, [bm[m][3]/bm[m][1]-bm[m][0]/bm[m][1] for m in ms], '--s', ms=4, lw=2, **PL)
ax.axhline(0, color='black', lw=1)
ax.set_xlabel('strength margin  a − d'); ax.set_ylabel('model − observed  P(capture)')
ax.set_title('residual (closer to 0 = better)')
ax.grid(alpha=.3); ax.legend()
fig.tight_layout(rect=[0, 0, 1, 0.96])
pdf.savefig(fig); plt.close(fig)

# ===================== PAGE 3 : ratio-sensitivity (capture vs a for fixed d) =====================
fig, axes = plt.subplots(2, 2, figsize=(11, 8.5)); fig.suptitle('Ratio-sensitivity — capture vs attacker size at fixed defender size', size=14, weight='bold')
for ax, dfix in zip(axes.flat, [2, 3, 4, 5]):
    A = list(range(2, 13))
    da=[a for a in A if cell.get((a,dfix),[0,0])[1] >= 20]
    do=[cell[(a,dfix)][0]/cell[(a,dfix)][1] for a in da]
    de=[math.sqrt(p*(1-p)/cell[(a,dfix)][1]) for p,a in zip(do,da)]
    ax.errorbar(da, do, yerr=de, fmt='o', ms=5, capsize=2, **DT, zorder=3)
    ax.plot(A, [cf_pcap(a,dfix) for a in A], '-', lw=2, **CF)
    ax.plot(A, [pl_pcap(a,dfix) for a in A], '--', lw=2, **PL)
    ax.axvline(dfix, color='gray', ls=':', lw=1, label='a=d (parity)')
    ax.set_title(f'defender d = {dfix}'); ax.set_xlabel('attacker a'); ax.set_ylabel('P(capture)')
    ax.grid(alpha=.3); ax.set_ylim(-0.03, 1.03)
    if dfix == 2: ax.legend(fontsize=8)
fig.tight_layout(rect=[0, 0, 1, 0.95])
pdf.savefig(fig); plt.close(fig)

# ===================== PAGE 4 : occupier survivor mean =====================
fig, axes = plt.subplots(2, 2, figsize=(11, 8.5))
fig.suptitle('Occupier survivors after a CAPTURE — mean troops left on the taken node (vs a−d=margin alone)', size=13, weight='bold')
for ax, dfix in zip(axes.flat, [1, 2, 3, 4]):
    A=[a for a in range(2,13) if (a,dfix) in occ_s and len(occ_s[(a,dfix)])>=20]
    if not A: ax.set_visible(False); continue
    do=[np.mean(occ_s[(a,dfix)]) for a in A]
    de=[np.std(occ_s[(a,dfix)])/math.sqrt(len(occ_s[(a,dfix)])) for a in A]
    ax.errorbar(A, do, yerr=de, fmt='o', ms=5, capsize=2, **DT, zorder=3)
    ax.plot(A, [mu_occ(a,dfix) for a in A], '-', lw=2, **CF)
    ax.plot(A, [pl_mocc(a,dfix) for a in A], '--', lw=2, **PL)
    ax.plot(A, [max(1,a-dfix) for a in A], ':', lw=1.5, color='gray', label='margin a−d (naive)')
    ax.set_title(f'defender d = {dfix}'); ax.set_xlabel('attacker a'); ax.set_ylabel('occupier troops')
    ax.grid(alpha=.3)
    if dfix == 1: ax.legend(fontsize=8)
fig.tight_layout(rect=[0, 0, 1, 0.95])
pdf.savefig(fig); plt.close(fig)

# ===================== PAGE 5 : remnant survivor mean =====================
fig, axes = plt.subplots(2, 2, figsize=(11, 8.5))
fig.suptitle('Defender remnant after a REPEL — mean troops left on the held node (assault guts the defender)', size=13, weight='bold')
for ax, dfix in zip(axes.flat, [3, 4, 5, 6]):
    A=[a for a in range(2,13) if (a,dfix) in rem_s and len(rem_s[(a,dfix)])>=20]
    if not A: ax.set_visible(False); continue
    do=[np.mean(rem_s[(a,dfix)]) for a in A]
    de=[np.std(rem_s[(a,dfix)])/math.sqrt(len(rem_s[(a,dfix)])) for a in A]
    ax.errorbar(A, do, yerr=de, fmt='o', ms=5, capsize=2, **DT, zorder=3)
    ax.plot(A, [mu_rem(a,dfix) for a in A], '-', lw=2, **CF)
    ax.plot(A, [pl_mrem(a,dfix) for a in A], '--', lw=2, **PL)
    ax.plot(A, [max(0,dfix-a+1) for a in A], ':', lw=1.5, color='gray', label='d−a+1 (naive)')
    ax.set_title(f'defender d = {dfix}'); ax.set_xlabel('attacker a'); ax.set_ylabel('remnant troops')
    ax.grid(alpha=.3)
    if dfix == 3: ax.legend(fontsize=8)
fig.tight_layout(rect=[0, 0, 1, 0.95])
pdf.savefig(fig); plt.close(fig)

# ===================== PAGE 6 : survivor DISTRIBUTIONS =====================
# pick the highest-count cells that also show real spread (attacker/defender >= 3)
occ_cells = sorted((c for c in occ_s if len(occ_s[c]) >= 60 and c[0] >= 4),
                   key=lambda c: -len(occ_s[c]))[:3]
rem_cells = sorted((c for c in rem_s if len(rem_s[c]) >= 60 and c[1] >= 3),
                   key=lambda c: -len(rem_s[c]))[:3]
fig, axes = plt.subplots(2, 3, figsize=(11, 8.5))
fig.suptitle('Survivor DISTRIBUTIONS — we match the spread, not just the mean', size=14, weight='bold')
def smp_pmf(samples, kmax):
    h = np.bincount(np.asarray(samples, int), minlength=kmax+1)[:kmax+1]
    return h/h.sum()
def dist_panel(ax, p_dat, p_cf, p_pl, title, kmax):
    ks = np.arange(0, kmax+1); w=0.27
    ax.bar(ks-w, p_dat, w, color='black', alpha=.75, label='data')
    ax.bar(ks,    p_cf,  w, color=CF['color'], alpha=.75, label='closed form')
    ax.bar(ks+w,  p_pl,  w, color=PL['color'], alpha=.75, label='hybrid loop')
    ax.set_title(title, size=10); ax.set_xlabel('troops'); ax.set_ylabel('probability')
    ax.set_xticks(ks); ax.grid(alpha=.25, axis='y')
for ax, (a,d) in zip(axes[0], occ_cells):
    dist_panel(ax, smp_pmf(occ_s[(a,d)], a-1), smp_pmf(cf_occ_samples(a,d), a-1),
               pl_occ_pmf(a, d, a-1),
               f'CAPTURE occupier  a={a}, d={d}  (n={len(occ_s[(a,d)])})', a-1)
for ax, (a,d) in zip(axes[1], rem_cells):
    dist_panel(ax, smp_pmf(rem_s[(a,d)], d), smp_pmf(cf_rem_samples(a,d), d),
               pl_rem_pmf(a, d, d),
               f'REPEL remnant  a={a}, d={d}  (n={len(rem_s[(a,d)])})', d)
axes[0][0].legend(fontsize=8)
fig.tight_layout(rect=[0, 0, 1, 0.96])
pdf.savefig(fig); plt.close(fig)

# ===================== PAGE 7 : per-cell calibration =====================
fig, axes = plt.subplots(1, 2, figsize=(11, 8.5)); fig.suptitle('Per-cell calibration — predicted vs observed capture rate (point size ∝ #battles)', size=13, weight='bold')
big = [(a,d,c,n) for a,d,c,n in cells if n >= 30]
obs = np.array([c/n for a,d,c,n in big]); sz = np.array([n for *_,n in big])
for ax, (pf, mt) in zip(axes, [(cf_pcap, CF), (pl_pcap, PL)]):
    pred = np.array([pf(a,d) for a,d,c,n in big])
    ax.scatter(pred, obs, s=sz/12, c=mt['color'], alpha=.45, edgecolors='none')
    ax.plot([0,1],[0,1], 'k--', lw=1)
    rmse = math.sqrt(np.average((pred-obs)**2, weights=sz))
    ax.set_title(f"{mt['label']}   (n-weighted RMSE {rmse:.3f})"); ax.set_xlabel('predicted P(capture)')
    ax.set_ylabel('observed capture rate'); ax.set_xlim(-.02,1.02); ax.set_ylim(-.02,1.02); ax.grid(alpha=.3)
pdf.savefig(fig); plt.close(fig)

pdf.close()
print(f'wrote {OUT}')
print(f'closed-form AIC {cf_aic:.0f}  occRMSE {occ_rmse(mu_occ):.3f}  remRMSE {rem_rmse(mu_rem):.3f}')
print(f'plausible   AIC {pl_aic:.0f}  occRMSE {occ_rmse(pl_mocc):.3f}  remRMSE {rem_rmse(pl_mrem):.3f}')
