#!/usr/bin/env python3
"""Re-fit the red-attacker capture probability P(capture | a, d) from ALL live
battle data, comparing candidate models by parsimony + fit (log-lik / AIC).

No scipy: logistic models fit by Newton-Raphson (IRLS) in pure numpy.

Usage: python refit_battle.py /tmp/all_battles.csv
"""
import sys, csv, math
import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/all_battles.csv'

a_list, d_list, y_list = [], [], []
with open(path) as f:
    for r in csv.DictReader(f):
        try:
            a = int(r['a']); d = int(r['d'])
        except (ValueError, TypeError):
            continue
        if a < 1 or d < 1:
            continue
        a_list.append(a); d_list.append(d)
        y_list.append(1 if r['outcome'] == 'capture' else 0)

a = np.array(a_list, float); d = np.array(d_list, float)
y = np.array(y_list, float)
N = len(y)
print(f'N = {N} red-attacker battles  ({int(y.sum())} captures, {int(N-y.sum())} repels)')
print(f'overall capture rate: {y.mean()*100:.1f}%\n')

# ---- raw empirical curves ----
def curve(key, label):
    from collections import defaultdict
    b = defaultdict(lambda: [0, 0])
    for k, yy in zip(key, y):
        b[k][0] += yy; b[k][1] += 1
    print(f'capture rate by {label}:')
    for k in sorted(b):
        c, t = b[k]
        if t >= 5:
            se = math.sqrt(max(c/t*(1-c/t), 1e-9)/t)
            print(f'  {k:>5}: {int(c):4d}/{int(t):4d} = {c/t*100:5.1f}%  (±{se*100:.1f})')
    print()

margin = (a - d).astype(int)
curve([int(m) if -4 <= m <= 4 else (5 if m > 4 else -5) for m in margin],
      'margin a-d (±5 = clipped)')

# ---- IRLS logistic fit on an arbitrary design matrix ----
def fit_logit(X):
    n, p = X.shape
    w = np.zeros(p)
    for _ in range(200):
        z = X @ w
        mu = 1/(1+np.exp(-z))
        mu = np.clip(mu, 1e-9, 1-1e-9)
        W = mu*(1-mu)
        grad = X.T @ (y - mu)
        H = (X * W[:, None]).T @ X
        try:
            step = np.linalg.solve(H + 1e-8*np.eye(p), grad)
        except np.linalg.LinAlgError:
            break
        w = w + step
        if np.max(np.abs(step)) < 1e-10:
            break
    z = X @ w
    mu = np.clip(1/(1+np.exp(-z)), 1e-12, 1-1e-12)
    ll = float(np.sum(y*np.log(mu) + (1-y)*np.log(1-mu)))
    return w, ll

ones = np.ones(N)
la, ld = np.log(a), np.log(d)
lr = la - ld                      # log(a/d)
mar = a - d

models = {
    'M1 margin (a-d), 2p':           np.column_stack([ones, mar]),
    'M2 log-ratio ln(a/d), 2p':      np.column_stack([ones, lr]),
    'M3 ln a, ln d (sep exp), 3p':   np.column_stack([ones, la, ld]),
    'M4 margin + log-ratio, 3p':     np.column_stack([ones, mar, lr]),
    'M5 a, d linear, 3p':            np.column_stack([ones, a, d]),
}

print('=== model comparison (logistic MLE, IRLS) ===')
print(f'{"model":<34}{"params":>7}{"logLik":>11}{"AIC":>10}')
results = {}
for name, X in models.items():
    w, ll = fit_logit(X)
    p = X.shape[1]
    aic = 2*p - 2*ll
    results[name] = (w, ll, aic, p)
    print(f'{name:<34}{p:>7}{ll:>11.1f}{aic:>10.1f}')

best = min(results, key=lambda k: results[k][2])
print(f'\nbest by AIC: {best}')

# ---- detail on the two simplest 2p models + calibration ----
def report(name):
    w, ll, aic, p = results[name]
    print(f'\n--- {name} ---  w = {np.round(w,4).tolist()}  AIC={aic:.1f}')
    return w

w_mar = report('M1 margin (a-d), 2p')
w_lr  = report('M2 log-ratio ln(a/d), 2p')

# Express M2 as power-ratio P = a^g/(a^g + c d^g)
b0, g = w_lr
c = math.exp(-b0)
print(f'\nM2 as power-ratio:  P = a^g / (a^g + c·d^g)   g={g:.3f}, c={c:.3f}')
print('  (P at margin: depends on a,d separately, not just a-d)')

# Calibration: predicted vs observed by margin for each 2p model
print('\n=== calibration by margin: observed vs M1(margin) vs M2(ratio) ===')
print(f'{"a-d":>5}{"n":>6}{"obs%":>8}{"M1%":>8}{"M2%":>8}')
from collections import defaultdict
bm = defaultdict(list)
for i in range(N):
    bm[int(mar[i])].append(i)
for m in sorted(bm):
    idxs = bm[m]
    if len(idxs) < 10:
        continue
    obs = float(np.mean(y[idxs]))
    p1 = float(np.mean(1/(1+np.exp(-(w_mar[0]+w_mar[1]*mar[idxs])))))
    p2 = float(np.mean(1/(1+np.exp(-(w_lr[0]+w_lr[1]*lr[idxs])))))
    print(f'{m:>5}{len(idxs):>6}{obs*100:>8.1f}{p1*100:>8.1f}{p2*100:>8.1f}')
