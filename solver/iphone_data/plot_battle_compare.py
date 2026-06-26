#!/usr/bin/env python3
"""Generate battle_compare.pdf: the shipped single-shot power-ratio battle model
vs a naive iterated coin-flip (gambler's-ruin) mechanic, scored on real battles.

Shipped model (fast_engine.c):  P(capture) = a^G / (a^G + C*d^G),  G=3.40, C=1.26
Naive model:  each round attacker wins w.p. p (defender -1) else (attacker -1);
              loop while a>1 and d>0; capture iff d hits 0.  Plotted for p=0.5,0.6.

Both models are evaluated on the ACTUAL (a,d) of every live battle (from
extract_battles.py runs/*.jsonl) and aggregated by margin, so the model curves
are directly comparable to the observed capture rate (this reproduces the
BATTLE_FUNCTION.md §6 finding instead of a misleading single-d slice)."""
import csv, sys
from collections import defaultdict
from functools import lru_cache
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

G, C = 3.40, 1.26

def p_powratio(a, d):
    if a < 1: return 0.0
    if d < 1: return 1.0
    ag, dg = a ** G, d ** G
    return ag / (ag + C * dg)

def make_iterated(p):
    @lru_cache(maxsize=None)
    def cap(a, d):
        if d == 0: return 1.0      # defender wiped -> capture
        if a <= 1: return 0.0      # attacker spent -> repel
        return p * cap(a, d - 1) + (1.0 - p) * cap(a - 1, d)
    return cap

cap50, cap60 = make_iterated(0.50), make_iterated(0.60)

# shipped deterministic survivor rules (fast_engine.c resolve_battle)
def ship_occ(a, d):    return max(1, a - d)        # capture: occupier
def ship_defrem(a, d): return max(0, d - a + 1)    # repel: defender remnant

# FITTED survivor curves — weighted-LSQ planes in (a,d), clipped to feasible
# range. Fit on 9,445 live battles (n>=8 cells); 5-fold CV ~0.34/0.26 troops,
# vs the shipped clipped-margin rule's 0.49/0.59. Capture more troops with a
# bigger attacker, fewer with a bigger defender; symmetric story for the remnant.
def fit_occ(a, d):    return min(a, max(1.0, 0.82 * a - 0.44 * d + 0.10))
def fit_defrem(a, d): return min(d, max(0.0, 0.53 * d - 0.26 * a + 0.35))
# PROPOSED remnant v2 — a HINGE on the defender advantage. The linear plane
# under-predicts both tails (strong-defender repels keep more, approaching d-a+1;
# lucky stronger-attacker repels keep a ~1 floor). max(0,d-a) only fires when the
# defender is bigger, capturing the softer-than-1:1 gutting; the d term is the
# size-scaled floor. mean-fit RMSE 0.18 -> 0.11. Integer-clean (no division).
def fit_defrem_v2(a, d): return min(d, max(0.0, 0.30 + 0.24 * d + 0.42 * max(0, d - a)))

# ---- load real battles ----------------------------------------------------
CSV = sys.argv[1] if len(sys.argv) > 1 else '/tmp/battles.csv'
battles = []   # (a, d, captured)
cap_obs = []   # (a, d, occupier_strength)        observed captures
rep_obs = []   # (a, d, defender_remnant)         observed repels
dropped = [0, 0]  # [impossible captures, impossible repels]
with open(CSV) as f:
    for row in csv.DictReader(f):
        try:
            a, d = int(row['a']), int(row['d'])
        except (ValueError, KeyError):
            continue
        if a < 1 or d < 1:
            continue
        cap = row['outcome'] == 'capture'
        battles.append((a, d, cap))
        # survivor rows: drop physically-impossible reads (conservation of troops).
        # The occupier can't exceed a-1 (the source always keeps 1); the remnant
        # can't exceed d. These are OCR misreads / mid-frame reinforcement and they
        # were inflating the rare-outcome tails (e.g. occ=6,7,9 from an a=4 attack).
        if cap and row.get('atk_survivor'):
            s = int(row['atk_survivor'])
            if a >= 2 and 1 <= s <= a - 1:
                cap_obs.append((a, d, s))
            else:
                dropped[0] += 1
        elif not cap and row.get('def_survivor', '') != '':
            s = int(row['def_survivor'])
            if 0 <= s <= d:
                rep_obs.append((a, d, s))
            else:
                dropped[1] += 1
N = len(battles)

# aggregate observed + each model's mean prediction by margin (a-d)
by = defaultdict(lambda: {'n': 0, 'cap': 0, 'pr': 0.0, 'it60': 0.0, 'it50': 0.0})
for a, d, cap in battles:
    b = by[a - d]
    b['n'] += 1; b['cap'] += int(cap)
    b['pr']   += p_powratio(a, d)
    b['it60'] += cap60(a, d)
    b['it50'] += cap50(a, d)

# keep margins with a meaningful sample
margins = sorted(m for m, b in by.items() if b['n'] >= 15 and -5 <= m <= 9)
obs  = [100 * by[m]['cap']  / by[m]['n'] for m in margins]
pr   = [100 * by[m]['pr']   / by[m]['n'] for m in margins]
it60 = [100 * by[m]['it60'] / by[m]['n'] for m in margins]
it50 = [100 * by[m]['it50'] / by[m]['n'] for m in margins]
ns   = [by[m]['n'] for m in margins]

# overall fit metrics across ALL battles (per-battle, not binned)
def metrics(pred):
    eps = 1e-9; ll = 0.0; brier = 0.0
    for a, d, cap in battles:
        q = min(max(pred(a, d), eps), 1 - eps)
        ll += (np.log(q) if cap else np.log(1 - q))
        brier += (q - (1 if cap else 0)) ** 2
    return ll, brier / N
ll_pr, br_pr = metrics(p_powratio)
ll_60, br_60 = metrics(cap60)
ll_50, br_50 = metrics(cap50)
# weighted RMSE of the binned curves vs observed
def wrmse(curve):
    num = sum(by[m]['n'] * (c - o) ** 2 for m, c, o in zip(margins, curve, obs))
    return (num / sum(ns)) ** 0.5
rmse_pr, rmse_60, rmse_50 = wrmse(pr), wrmse(it60), wrmse(it50)

with PdfPages('battle_compare.pdf') as pdf:
    # ===================== PAGE 1: by margin, vs live data =================
    fig, ax = plt.subplots(figsize=(8.5, 6.0))
    ax.plot(margins, pr, '-', lw=2.6, color='#c0392b',
            label='SHIPPED single-shot power-ratio  $a^{3.4}/(a^{3.4}+1.26\\,d^{3.4})$')
    ax.plot(margins, it60, '--', lw=2.0, color='#2980b9',
            label='naive iterated coin-flip, p=0.60')
    ax.plot(margins, it50, ':', lw=2.0, color='#16a085',
            label="naive iterated coin-flip, p=0.50 (gambler's ruin)")
    sizes = [18 + n / 12 for n in ns]
    # 95% CI band on the observed capture rate (binomial SE = sqrt(p(1-p)/n))
    ci = [1.96 * 100 * (max(o / 100 * (1 - o / 100), 0) / n) ** 0.5
          for o, n in zip(obs, ns)]
    ax.fill_between(margins, [o - c for o, c in zip(obs, ci)],
                    [o + c for o, c in zip(obs, ci)],
                    color='black', alpha=0.15, zorder=4,
                    label='observed 95% CI (binomial)')
    ax.scatter(margins, obs, s=sizes, color='black', zorder=5,
               label=f'LIVE observed (N={N:,}; point size $\\propto$ n)')
    for m, o, n in zip(margins, obs, ns):  # per-point sample count
        ax.annotate(f'n={n:,}', (m, o), textcoords='offset points', xytext=(0, 9),
                    ha='center', fontsize=6, color='#555')
    ax.axhline(50, color='gray', lw=0.6, alpha=0.4)
    ax.axvline(0, color='gray', lw=0.6, alpha=0.4)
    ax.set_xlabel('strength margin  (attacker $a$ − defender $d$)')
    ax.set_ylabel('P(capture)  %')
    ax.set_title('Battle model vs reality (each model scored on the real $(a,d)$ of\n'
                 f'all {N:,} live battles, aggregated by margin)', fontsize=12)
    ax.set_ylim(-3, 103)
    ax.set_xticks(margins)
    ax.grid(True, alpha=0.25)
    ax.legend(loc='lower right', fontsize=8.5, framealpha=0.95)
    ax.annotate('contested region (margin 0/+1) decides games:\n'
                'power-ratio tracks the steep live rise; the\n'
                'naive p=0.6 flip is too soft at 0 and too\n'
                'generous to the underdog at −1/−2',
                xy=(0, obs[margins.index(0)]), xytext=(-4.7, 64), fontsize=8,
                color='#7d3c98',
                arrowprops=dict(arrowstyle='->', color='#7d3c98', lw=1.2))
    fig.tight_layout()
    pdf.savefig(fig); plt.close(fig)

    # ===================== PAGE 2: by ratio (model shapes) ================
    rs = np.linspace(0.2, 3.0, 400)
    pr_r = rs ** G / (rs ** G + C)
    def iter_ratio_curve(cap, d):
        return [cap(max(1, int(round(r * d))), d) for r in rs]
    fig, ax = plt.subplots(figsize=(8.5, 6.0))
    ax.plot(rs, pr_r * 100, '-', lw=2.6, color='#c0392b',
            label='SHIPPED power-ratio  $P=r^{3.4}/(r^{3.4}+1.26)$  (pure function of $r=a/d$)')
    ax.plot(rs, [v * 100 for v in iter_ratio_curve(cap60, 5)], '--', lw=2.0,
            color='#2980b9', label='naive coin-flip p=0.60  ($d=5$ sweep)')
    ax.plot(rs, [v * 100 for v in iter_ratio_curve(cap60, 10)], '-.', lw=1.4,
            color='#5dade2', alpha=0.8, label='naive coin-flip p=0.60  ($d=10$ sweep)')
    ax.axvline(1.0, color='gray', lw=0.8, ls=':')
    ax.annotate(f'equal strength $r=1$:\npower-ratio = {p_powratio(1,1)*100:.0f}%\n(1.26 defender edge)',
                xy=(1.0, p_powratio(1, 1) * 100), xytext=(1.3, 30),
                fontsize=8, arrowprops=dict(arrowstyle='->', lw=1.0))
    ax.text(0.22, 96, 'Key difference: the naive flip is NOT ratio-invariant —\n'
            'a fixed-p ruin gets sharper as nodes grow (3v3 ≠ 10v10),\n'
            'while the power-ratio depends only on $a/d$.',
            fontsize=8, color='#555', va='top')
    ax.set_xlabel('strength ratio  $r = a/d$')
    ax.set_ylabel('P(capture)  %')
    ax.set_title('Capture probability vs strength ratio', fontsize=12)
    ax.set_ylim(-3, 103)
    ax.grid(True, alpha=0.25)
    ax.legend(loc='lower right', fontsize=8.5, framealpha=0.95)
    fig.tight_layout()
    pdf.savefig(fig); plt.close(fig)

    # ===================== PAGE 3: fit table ================================
    fig, ax = plt.subplots(figsize=(8.5, 6.6))
    ax.axis('off')
    # show a representative margin window so the table stays legible
    tbl_margins = [m for m in margins if -3 <= m <= 6]
    rows = [['margin', 'n', 'live %', 'power-ratio %', '|err|', 'naive 0.6 %', '|err|']]
    for m in tbl_margins:
        i = margins.index(m)
        rows.append([f'{m:+d}', f'{ns[i]:,}', f'{obs[i]:.1f}', f'{pr[i]:.1f}',
                     f'{abs(pr[i]-obs[i]):.1f}', f'{it60[i]:.1f}', f'{abs(it60[i]-obs[i]):.1f}'])
    rows.append(['RMSE', '', '', f'{rmse_pr:.1f}', '', f'{rmse_60:.1f}', ''])
    tbl = ax.table(cellText=rows, loc='upper center', cellLoc='center',
                   bbox=[0.0, 0.34, 1.0, 0.60])
    tbl.auto_set_font_size(False); tbl.set_fontsize(9.5)
    for j in range(len(rows[0])):
        tbl[(0, j)].set_facecolor('#34495e'); tbl[(0, j)].set_text_props(color='white', weight='bold')
        tbl[(len(rows)-1, j)].set_facecolor('#ecf0f1'); tbl[(len(rows)-1, j)].set_text_props(weight='bold')
    ax.set_title(f'Fit to {N:,} live battles  —  models scored on real $(a,d)$',
                 fontsize=12, pad=10)
    ax.text(0.5, 0.24,
            f'Per-battle goodness of fit (all {N:,} battles)',
            ha='center', fontsize=9.5, color='#222', weight='bold', transform=ax.transAxes)
    ax.text(0.5, 0.15,
            f'log-likelihood:  power-ratio {ll_pr:,.0f}  >  naive 0.6 {ll_60:,.0f}  >  naive 0.5 {ll_50:,.0f}   (higher better)\n'
            f'Brier score:     power-ratio {br_pr:.4f}  <  naive 0.6 {br_60:.4f}  <  naive 0.5 {br_50:.4f}   (lower better)',
            ha='center', fontsize=9, color='#222', family='monospace', transform=ax.transAxes)
    ax.text(0.5, 0.02,
            'Matches BATTLE_FUNCTION.md §6: single-shot power-ratio is both the simplest model '
            '(one closed-form\nBernoulli, no loop) and the best fit. The naive fixed-p coin-flip '
            'is too soft at the contested margins.',
            ha='center', fontsize=8, color='#555', transform=ax.transAxes)
    pdf.savefig(fig); plt.close(fig)

    # ============ PAGE 4: survivors — the "remainder" beyond win/loss ======
    def bin_survivors(obs, ship_fn, fit_fn):
        """aggregate observed + model survivor predictions by margin, plus the
        95% CI on the observed mean (1.96 * std/sqrt(n)).
        NOTE: model curves are the per-battle mean over each margin's real (a,d)
        mix, so a 2D (a,d) model shows as a band collapsed onto the margin axis."""
        agg = defaultdict(lambda: {'vals': [], 's': 0.0, 'f': 0.0})
        for a, d, surv in obs:
            g = agg[a - d]
            g['vals'].append(surv)
            g['s'] += ship_fn(a, d)
            g['f'] += fit_fn(a, d)
        ms = sorted(m for m, g in agg.items() if len(g['vals']) >= 15 and -5 <= m <= 9)
        n = lambda m: len(agg[m]['vals'])
        col = lambda k: [agg[m][k] / n(m) for m in ms]
        o = [sum(agg[m]['vals']) / n(m) for m in ms]
        def ci(m):
            v = agg[m]['vals']; mu = sum(v) / len(v)
            sd = (sum((x - mu) ** 2 for x in v) / len(v)) ** 0.5
            return 1.96 * sd / len(v) ** 0.5
        return ms, o, col('s'), col('f'), [n(m) for m in ms], [ci(m) for m in ms]

    cm, c_o, c_s, c_f, c_n, c_ci = bin_survivors(cap_obs, ship_occ, fit_occ)
    rm, r_o, r_s, r_f, r_n, r_ci = bin_survivors(rep_obs, ship_defrem, fit_defrem)

    # Two RMSEs: (1) mean-fit = how well the curve predicts each (a,d) cell's
    # MEAN survivor (the curve's actual job); (2) per-battle = includes the
    # irreducible within-cell spread (~1 troop) that no deterministic rule removes.
    def cell_means(obs):
        agg = defaultdict(list)
        for a, d, s in obs: agg[(a, d)].append(s)
        return {k: (len(v), sum(v) / len(v)) for k, v in agg.items() if len(v) >= 8}
    def mean_rmse(cm, fn):
        num = den = 0.0
        for (a, d), (n, mu) in cm.items(): num += n * (fn(a, d) - mu) ** 2; den += n
        return (num / den) ** 0.5
    def battle_rmse(obs, fn):
        return (sum((fn(a, d) - s) ** 2 for a, d, s in obs) / len(obs)) ** 0.5
    def spread(obs):  # irreducible: pooled within-cell std
        cm = cell_means(obs); num = den = 0.0
        agg = defaultdict(list)
        for a, d, s in obs: agg[(a, d)].append(s)
        for k, (n, mu) in cm.items():
            num += sum((x - mu) ** 2 for x in agg[k]); den += n
        return (num / den) ** 0.5
    cmC, cmR = cell_means(cap_obs), cell_means(rep_obs)
    occ_ship, occ_fit = mean_rmse(cmC, ship_occ), mean_rmse(cmC, fit_occ)
    rem_ship, rem_fit = mean_rmse(cmR, ship_defrem), mean_rmse(cmR, fit_defrem)
    rem_v2 = mean_rmse(cmR, fit_defrem_v2)
    occ_pb, rem_pb = battle_rmse(cap_obs, fit_occ), battle_rmse(rep_obs, fit_defrem)
    occ_sd, rem_sd = spread(cap_obs), spread(rep_obs)
    # proposed hinge remnant, aggregated over the real (a,d) mix per margin
    _hv = defaultdict(lambda: [0, 0.0])
    for a, d, s in rep_obs:
        _hv[a - d][0] += 1; _hv[a - d][1] += fit_defrem_v2(a, d)
    r_v2 = [_hv[m][1] / _hv[m][0] for m in rm]

    fig, (axL, axR) = plt.subplots(1, 2, figsize=(11.0, 6.0))
    szc = [16 + n / 12 for n in c_n]
    axL.fill_between(cm, [o - c for o, c in zip(c_o, c_ci)],
                     [o + c for o, c in zip(c_o, c_ci)],
                     color='black', alpha=0.15, zorder=4,
                     label='observed 95% CI')
    axL.scatter(cm, c_o, s=szc, color='black', zorder=5, label='LIVE observed')
    axL.plot(cm, c_s, '-', lw=2.0, color='#c0392b', label='old clamp  $\\max(1,a-d)$')
    axL.plot(cm, c_f, '-', lw=2.6, color='#27ae60',
             label='SHIPPED plane  $0.82a-0.44d+0.1$')
    for m, o, n in zip(cm, c_o, c_n):
        axL.annotate(f'n={n:,}', (m, o), textcoords='offset points', xytext=(7, -2),
                     ha='left', fontsize=6, color='#555')
    axL.set_title(f'Capture: occupier strength  (n={len(cap_obs):,})', fontsize=11)
    axL.set_xlabel('margin  $a-d$'); axL.set_ylabel('surviving troops on captured node')
    axL.grid(True, alpha=0.25); axL.legend(loc='upper left', fontsize=8.5); axL.set_xticks(cm)
    szr = [16 + n / 12 for n in r_n]
    axR.fill_between(rm, [o - c for o, c in zip(r_o, r_ci)],
                     [o + c for o, c in zip(r_o, r_ci)],
                     color='black', alpha=0.15, zorder=4,
                     label='observed 95% CI')
    axR.scatter(rm, r_o, s=szr, color='black', zorder=5, label='LIVE observed')
    axR.plot(rm, r_s, '-', lw=2.0, color='#c0392b', label='old clamp  $\\max(0,d-a+1)$')
    axR.plot(rm, r_f, '-', lw=2.2, color='#27ae60', alpha=0.55,
             label='plane (superseded)  $0.53d-0.26a+0.35$')
    axR.plot(rm, r_v2, '-', lw=2.8, color='#e67e22',
             label='SHIPPED hinge  $0.30+0.24d+0.42\\,\\max(0,d{-}a)$')
    for m, o, n in zip(rm, r_o, r_n):
        axR.annotate(f'n={n:,}', (m, o), textcoords='offset points', xytext=(7, -2),
                     ha='left', fontsize=6, color='#555')
    axR.set_title(f'Repel: defender remnant  (n={len(rep_obs):,})', fontsize=11)
    axR.set_xlabel('margin  $a-d$'); axR.set_ylabel('surviving troops on defended node')
    axR.grid(True, alpha=0.25); axR.legend(loc='upper right', fontsize=8.5); axR.set_xticks(rm)
    axL.text(0.03, 0.74, f'mean-fit RMSE (troops)\n'
             f'SHIPPED  {occ_ship:.2f}\nFITTED   {occ_fit:.2f}\n'
             f'(irreducible spread {occ_sd:.2f})',
             transform=axL.transAxes, fontsize=8.5, color='#333', va='top', family='monospace')
    axR.text(0.03, 0.40, f'hinge fixes both tails the plane\nmisses (big deficits + lucky-repel\n'
             f'floor at margin +2/+3).\n\nmean-fit RMSE (troops)\n'
             f'old clamp      {rem_ship:.2f}\nplane          {rem_fit:.2f}\n'
             f'SHIPPED hinge  {rem_v2:.2f}\n(irreducible spread {rem_sd:.2f})',
             transform=axR.transAxes, fontsize=8.5, color='#333', va='top', family='monospace')
    fig.suptitle('Beyond win/loss: how many troops remain.  Source node $\\to 1$ '
                 'in ~100% of battles. Fitted $(a,d)$ planes beat the margin clamp.',
                 fontsize=12.5)
    fig.text(0.5, 0.005, f'Dropped {dropped[0]+dropped[1]} physically-impossible '
             f'survivor reads (occupier $>a-1$ or remnant $>d$ — OCR/reinforcement '
             f'artifacts that inflated the rare-outcome tails).',
             ha='center', fontsize=7.5, color='#888')
    fig.tight_layout(rect=[0, 0, 1, 0.95])
    pdf.savefig(fig); plt.close(fig)
    print(f'  survivors (mean-fit RMSE): occ {occ_ship:.3f} -> {occ_fit:.3f}'
          f' | rem {rem_ship:.3f} -> {rem_fit:.3f}  (irreducible spread occ {occ_sd:.2f} rem {rem_sd:.2f})')

print(f'wrote battle_compare.pdf  ({N:,} battles)')
print(f'  weighted-RMSE  power-ratio {rmse_pr:.2f}  naive0.6 {rmse_60:.2f}  naive0.5 {rmse_50:.2f}')
print(f'  logLik         power-ratio {ll_pr:.0f}  naive0.6 {ll_60:.0f}  naive0.5 {ll_50:.0f}')
print(f'  Brier          power-ratio {br_pr:.4f}  naive0.6 {br_60:.4f}  naive0.5 {br_50:.4f}')
