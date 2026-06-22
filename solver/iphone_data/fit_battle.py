#!/usr/bin/env python3
"""Fit the real iOS battle function from extracted single-battle observations.

Input: CSV from extract_battles.py (a, d, outcome, atk_survivor, src_after,
def_survivor). Fits and compares candidate P(capture | a, d) models by MLE/AIC,
and fits the SURVIVOR rule (troops remaining on the contested node) for both
outcomes. The goal: replace the shipped iterated-Bernoulli-at-0.60 mechanic
(network_wars.resolve_battle) with whatever the data actually supports.

Models for P(capture):
  bernoulli(p)   exact gambler's-ruin DP matching resolve_battle's absorbing
                 states (attacker stops at garrison a==1; capture when d==0).
                 free param p; p=0.60 is the currently-shipped value.
  powratio(g,c)  P = a^g / (a^g + c*d^g)  (Bradley-Terry / softmax on log-strength)
  logistic(k,b)  P = sigmoid(k*(a-d) + b)  (margin model)
  determ(eps)    P = 1-eps if a>d, 0.5 if a==d, eps if a<d (near-deterministic)

Usage:
  python extract_battles.py runs/*.jsonl > battles.csv
  python fit_battle.py battles.csv
"""
import csv, math, sys
import numpy as np


def grid1d(f, lo, hi, steps=60, refines=3):
    """Minimize 1-arg f on [lo,hi] by grid + zoom (scipy-free)."""
    for _ in range(refines):
        xs = np.linspace(lo, hi, steps)
        ys = [f(x) for x in xs]
        i = int(np.argmin(ys))
        lo = xs[max(0, i - 1)]; hi = xs[min(len(xs) - 1, i + 1)]
    x = (lo + hi) / 2
    return x, f(x)


def grid2d(f, b0, b1, steps=40, refines=4):
    """Minimize 2-arg f over boxes b0,b1 by grid + zoom (scipy-free)."""
    lo0, hi0 = b0; lo1, hi1 = b1
    best = None
    for _ in range(refines):
        xs = np.linspace(lo0, hi0, steps); ys = np.linspace(lo1, hi1, steps)
        bi = None
        for x in xs:
            for y in ys:
                v = f((x, y))
                if bi is None or v < bi[0]:
                    bi = (v, x, y)
        _, bx, by = bi
        dx = (hi0 - lo0) / steps; dy = (hi1 - lo1) / steps
        lo0, hi0 = bx - dx, bx + dx; lo1, hi1 = by - dy, by + dy
        best = bi
    return (best[1], best[2]), best[0]

# ---- exact gambler's-ruin capture probability, matching resolve_battle ----
_RUIN_CACHE = {}
def ruin_capture_prob(a, d, p):
    """P(node captured) for attacker strength a vs defender d under the shipped
    loop: while a>1 and d>0: w.p. p defender loses 1 else attacker loses 1;
    capture iff d reaches 0 (attacker garrison absorbs at a==1)."""
    if a <= 1:
        return 0.0
    if d <= 0:
        return 1.0
    key = (a, d, round(p, 6))
    v = _RUIN_CACHE.get(key)
    if v is not None:
        return v
    # DP over (a,d); memoize. a in [1..A], d in [0..D].
    # P(a,d): a<=1 -> 0; d<=0 -> 1; else p*P(a,d-1)+(1-p)*P(a-1,d)
    from functools import lru_cache
    @lru_cache(maxsize=None)
    def P(a, d):
        if a <= 1:
            return 0.0
        if d <= 0:
            return 1.0
        return p * P(a, d - 1) + (1 - p) * P(a - 1, d)
    v = P(a, d)
    _RUIN_CACHE[key] = v
    return v


def load(path):
    rows = []
    for r in csv.DictReader(open(path)):
        try:
            a, d = int(r['a']), int(r['d'])
        except (ValueError, KeyError):
            continue
        if a <= 0 or d <= 0:
            continue
        cap = r['outcome'] == 'capture'
        rows.append({
            'a': a, 'd': d, 'cap': cap,
            'atk_survivor': _i(r.get('atk_survivor')),
            'src_after': _i(r.get('src_after')),
            'def_survivor': _i(r.get('def_survivor')),
        })
    return rows


def _i(s):
    try:
        return int(s)
    except (ValueError, TypeError):
        return None


def nll(probs, y):
    eps = 1e-9
    probs = np.clip(np.asarray(probs), eps, 1 - eps)
    y = np.asarray(y, float)
    return -np.sum(y * np.log(probs) + (1 - y) * np.log(1 - probs))


def aic(k, ll):
    return 2 * k - 2 * ll   # ll = -nll


def fit_models(rows):
    A = np.array([r['a'] for r in rows])
    D = np.array([r['d'] for r in rows])
    Y = np.array([1.0 if r['cap'] else 0.0 for r in rows])
    n = len(rows)
    out = {}

    # bernoulli(p)
    def bern_nll(p):
        pr = [ruin_capture_prob(a, d, p) for a, d in zip(A, D)]
        return nll(pr, Y)
    p_hat, f1 = grid1d(bern_nll, 0.40, 0.85)
    out['bernoulli(p)'] = {'params': {'p': p_hat}, 'k': 1, 'nll': f1}

    # powratio(g,c)
    def pr_nll(theta):
        g, c = theta
        if g <= 0 or c <= 0:
            return 1e9
        pr = (A ** g) / (A ** g + c * (D ** g))
        return nll(pr, Y)
    (g_h, c_h), f2 = grid2d(pr_nll, (0.3, 8.0), (0.2, 4.0))
    out['powratio(g,c)'] = {'params': {'g': g_h, 'c': c_h}, 'k': 2, 'nll': f2}

    # logistic(k,b) on margin a-d
    def lg_nll(theta):
        k, b = theta
        pr = 1 / (1 + np.exp(-(k * (A - D) + b)))
        return nll(pr, Y)
    (k_h, b_h), f3 = grid2d(lg_nll, (0.0, 5.0), (-4.0, 4.0))
    out['logistic(k,b)'] = {'params': {'k': k_h, 'b': b_h}, 'k': 2, 'nll': f3}

    # determ(eps,tie): near-deterministic with free tie-break
    def dt_nll(theta):
        eps, tie = theta
        eps = min(max(eps, 1e-6), 0.49); tie = min(max(tie, 0.0), 1.0)
        pr = np.where(A > D, 1 - eps, np.where(A < D, eps, tie))
        return nll(pr, Y)
    (e_h, t_h), f4 = grid2d(dt_nll, (1e-3, 0.49), (0.0, 1.0))
    out['determ(eps,tie)'] = {'params': {'eps': e_h, 'tie': t_h}, 'k': 2, 'nll': f4}

    print(f'\n=== P(capture) model comparison (n={n}) ===')
    print(f'{"model":<18}{"params":<34}{"nll":>9}{"AIC":>9}')
    best = min(out.items(), key=lambda kv: aic(kv[1]['k'], -kv[1]['nll']))
    for name, m in sorted(out.items(), key=lambda kv: aic(kv[1]['k'], -kv[1]['nll'])):
        ps = ' '.join(f'{k}={v:.3f}' for k, v in m['params'].items())
        a = aic(m['k'], -m['nll'])
        mark = '  <-- best' if name == best[0] else ''
        print(f'{name:<18}{ps:<34}{m["nll"]:>9.2f}{a:>9.1f}{mark}')
    return out


def calibration(rows):
    """Observed capture rate vs the shipped p=0.60 ruin prediction, binned by a-d."""
    print('\n=== calibration: observed vs shipped bernoulli(0.60), by margin a-d ===')
    from collections import defaultdict
    b = defaultdict(lambda: [0, 0, 0.0])  # cap, total, sum_pred
    for r in rows:
        m = r['a'] - r['d']
        key = max(-3, min(4, m))
        b[key][0] += r['cap']; b[key][1] += 1
        b[key][2] += ruin_capture_prob(r['a'], r['d'], 0.60)
    print(f'{"a-d":>5}{"n":>6}{"obs%":>8}{"pred%(0.60)":>13}')
    for k in sorted(b):
        c, t, sp = b[k]
        lab = f'{k:+d}' + ('+' if k == 4 else '') + ('-' if k == -3 else '')
        print(f'{lab:>5}{t:>6}{c/t*100:>7.1f}{sp/t*100:>12.1f}')


def survivor_fit(rows):
    """Fit the troops-remaining rule for both outcomes."""
    caps = [r for r in rows if r['cap'] and r['atk_survivor'] is not None]
    reps = [r for r in rows if not r['cap'] and r['def_survivor'] is not None]
    print('\n=== survivor rule ===')
    if caps:
        a = np.array([r['a'] for r in caps]); d = np.array([r['d'] for r in caps])
        s = np.array([r['atk_survivor'] for r in caps])
        # candidate: survivor == a - d ; report residual
        res = s - (a - d)
        print(f'CAPTURE (n={len(caps)}): captured-node troops')
        print(f'  survivor vs (a-d): mean resid={res.mean():+.2f} '
              f'median={np.median(res):+.0f} std={res.std():.2f} '
              f'| exact a-d in {np.mean(res==0)*100:.0f}% of cases')
        # least-squares survivor ~ x*a + y*d + b
        X = np.column_stack([a, d, np.ones_like(a)])
        coef, *_ = np.linalg.lstsq(X, s, rcond=None)
        print(f'  lstsq survivor ~ {coef[0]:+.2f}*a {coef[1]:+.2f}*d {coef[2]:+.2f}')
        src = np.array([r['src_after'] for r in caps if r['src_after'] is not None])
        print(f'  source-node left-behind: mean={src.mean():.2f} '
              f'(==1 in {np.mean(src==1)*100:.0f}% of cases)')
    if reps:
        a = np.array([r['a'] for r in reps]); d = np.array([r['d'] for r in reps])
        s = np.array([r['def_survivor'] for r in reps])
        res = s - (d - a)
        print(f'REPEL (n={len(reps)}): defender remnant')
        print(f'  def_survivor vs (d-a): mean resid={res.mean():+.2f} '
              f'median={np.median(res):+.0f} std={res.std():.2f} '
              f'| exact d-a in {np.mean(res==0)*100:.0f}% of cases')
        X = np.column_stack([a, d, np.ones_like(a)])
        coef, *_ = np.linalg.lstsq(X, s, rcond=None)
        print(f'  lstsq def_survivor ~ {coef[0]:+.2f}*a {coef[1]:+.2f}*d {coef[2]:+.2f}')


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'battles.csv'
    rows = load(path)
    print(f'loaded {len(rows)} battle observations from {path}')
    if not rows:
        return
    fit_models(rows)
    calibration(rows)
    survivor_fit(rows)


if __name__ == '__main__':
    main()
