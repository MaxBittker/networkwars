#!/usr/bin/env python3
"""Iterated (play-out) battle model for Network Wars.

The shipped engine (`fast_engine.c`) resolves a battle with a single closed-form
Bernoulli for the outcome and two separately-fitted distributions for the
survivors. This module is the historically-plausible ALTERNATIVE: the best single
iterated play-out — the kind of loop a game would actually run — that reproduces
the same 12,670 live battles, found by maximising the FULL joint likelihood
(outcome + the actual likelihood of every survivor count).

MODEL.  A lethal attacker trades volleys with the defender; its WIN is decoupled
from depletion by a ratio-sensitive rout, so a still-lethal attacker can be
repelled *after* it has gutted the defender. The occupier falls out of the
play-out. The REMNANT cannot (a depletion-repel self-selects for low damage, and
the real loss scales with the defender's size d), so it is a decoupled draw from
the documented "assault guts the defender" hinge — the one place the play-out
needs help.

    def battle(a, d, rand):                       # a attacks d;  rand() -> [0,1)
        while a > 1 and d > 0:
            if rand() < 0.50: d -= 1              # attacker volley lands (lethal)
            if rand() < 0.28: a -= 1              # defender volley lands
            elif rand() < 0.05*d**0.53/(d**0.53 + 4.98*a**0.53):
                break                             # attacker routs -> repel
        if d == 0:                                # CAPTURE (source keeps 1)
            return 'capture', a - 1
        mu = max(0.0, 0.30 + 0.24*d + 0.42*max(0, d - a))   # remnant hinge (decoupled)
        return 'repel', sum(rand() < mu/d for _ in range(d))

Fit vs the shipped closed form on the live data (joint negative-log-likelihood,
lower = better; excess over the 16,792-nat empirical noise floor):

    shipped closed form                 19134   (+2342)
    this hybrid (loop + hinge remnant)  18321   (+1529)   <- better overall

The hybrid wins by pairing the loop's better occupier — the shipped beta-binomial
occupier collapses onto its ceiling in high-margin small-army cells — with the
hinge remnant. This is a study artifact; the production engine keeps the closed
form. `python iterated_battle.py [battles.csv]` reprints the comparison; see
`ITERATED_BATTLE_MODELS.md` for the full write-up and `iphone_data/make_battle_pdf.py`
for the figures.
"""
import sys, math
from collections import defaultdict

# fitted parameters (lethal + rout; joint-likelihood optimum over the live data)
LA, LD, KR, CR, SA = 0.50, 0.28, 0.53, 4.98, 0.05

def mean_remnant(a, d):
    """Mean defender remnant on a repel — the 'assault guts the defender' hinge."""
    return min(max(0.30 + 0.24*d + 0.42*max(0, d - a), 0.0), float(d))

def mean_occupier(a, d):
    """Shipped occupier-mean plane (for reference / the closed form)."""
    return min(max(0.82*a - 0.44*d + 0.10, 1.0), max(1.0, a - 1.0))


# --------------------------------------------------------------------------- #
#  Executable loop (what a game would run)
# --------------------------------------------------------------------------- #
def battle(a, d, rand):
    """Resolve one battle. Returns ('capture', occupier) or ('repel', remnant).
    `rand` is a callable returning a float in [0,1). Source node always keeps 1."""
    while a > 1 and d > 0:
        if rand() < LA: d -= 1
        if rand() < LD: a -= 1
        elif rand() < SA * d**KR / (d**KR + CR * a**KR):
            break
    if d == 0:
        return 'capture', a - 1
    p = mean_remnant(a, d) / d if d else 0.0
    return 'repel', sum(rand() < p for _ in range(d))


# --------------------------------------------------------------------------- #
#  Exact distributions (DP) — for scoring and the figures
# --------------------------------------------------------------------------- #
def _loop_transitions(a, d):
    """One round of the lethal+rout play-out -> [(prob, a2, d2), ...]."""
    ra = min(SA * d**KR / (d**KR + CR * a**KR), 0.6)   # rout AFTER both volleys
    return [(LA*LD,           a-1, d-1),               # both volleys land
            (LA*(1-LD),       a,   d-1),               # attacker lands
            ((1-LA)*LD,       a-1, d),                 # defender lands
            ((1-LA)*(1-LD)*ra,       1, d),            # neither -> attacker routs
            ((1-LA)*(1-LD)*(1-ra),   a, d)]            # neither -> continue (self-loop)

def loop_dp():
    """f(a,d) -> (pcap, occ, rem): full joint distribution of the pure play-out.
    occ/rem are UNconditional masses (sum to pcap / 1-pcap). Memoised."""
    memo = {}
    def f(a, d):
        if d <= 0:  return (1.0, {a-1: 1.0}, {}) if a >= 2 else (0.0, {}, {0: 1.0})
        if a <= 1:  return (0.0, {}, {d: 1.0})
        if (a, d) in memo: return memo[(a, d)]
        pcap = 0.0; occ = defaultdict(float); rem = defaultdict(float); pself = 0.0
        for p, a2, d2 in _loop_transitions(a, d):
            if p <= 0: continue
            if a2 == a and d2 == d: pself += p; continue
            pc, od, rd = f(a2, d2)
            pcap += p*pc
            for k, v in od.items(): occ[k] += p*v
            for k, v in rd.items(): rem[k] += p*v
        z = max(1e-15, 1 - pself)
        memo[(a, d)] = (pcap/z, {k: v/z for k, v in occ.items()},
                        {k: v/z for k, v in rem.items()})
        return memo[(a, d)]
    return f

def _binom_pmf(n, p):
    p = min(max(p, 0.0), 1.0)
    return {k: math.comb(n, k) * p**k * (1-p)**(n-k) for k in range(n+1)}

def hybrid_dp():
    """The shipped-recommended study model: win + occupier from the play-out,
    remnant from the decoupled hinge draw. f(a,d) -> (pcap, occ, rem)."""
    lp = loop_dp()
    def f(a, d):
        pc, od, _ = lp(a, d)
        rem = {k: v*(1-pc) for k, v in _binom_pmf(d, mean_remnant(a, d)/d if d else 0).items()}
        return (pc, od, rem)
    return f

def closed_form_dp():
    """The SHIPPED closed form: power-ratio outcome + beta-binomial occupier +
    binomial remnant, as in fast_engine.c / BATTLE_FUNCTION.md. f(a,d)->(pcap,occ,rem)."""
    from math import lgamma, comb, exp
    RHO = 0.21
    def bb(n, p):                                   # beta-binomial pmf (rho=0.21)
        if n == 0: return {0: 1.0}
        s = (1-RHO)/RHO; al = max(p*s, 1e-6); be = max((1-p)*s, 1e-6)
        base = lgamma(al)+lgamma(be)-lgamma(al+be)
        return {k: exp(math.log(comb(n, k)) + lgamma(k+al)+lgamma(n-k+be)
                       - lgamma(n+al+be) - base) for k in range(n+1)}
    def f(a, d):
        pc = a**3.40 / (a**3.40 + 1.26*d**3.40)
        if a <= 2: occ = {1: 1.0}
        else:
            po = min(max((mean_occupier(a, d)-1)/(a-2), 1e-6), 1-1e-6)
            occ = {1+k: v for k, v in bb(a-2, po).items()}
        rem = _binom_pmf(d, mean_remnant(a, d)/d if d else 0)
        return (pc, {k: v*pc for k, v in occ.items()},
                {k: v*(1-pc) for k, v in rem.items()})
    return f


# --------------------------------------------------------------------------- #
#  Scoring against the live battle data (reproduces the write-up's numbers)
# --------------------------------------------------------------------------- #
def load_cells(csv_path):
    """Parse extract_battles.py CSV -> (outcome counts, occ hist, rem hist)."""
    import csv
    cell = defaultdict(lambda: [0, 0]); occ = defaultdict(lambda: defaultdict(int))
    rem = defaultdict(lambda: defaultdict(int))
    for r in csv.DictReader(open(csv_path)):
        try: a = int(r['a']); d = int(r['d'])
        except (ValueError, TypeError): continue
        if a < 2 or d < 1: continue
        cap = r['outcome'] == 'capture'; cell[(a, d)][0] += cap; cell[(a, d)][1] += 1
        if cap and r['atk_survivor']:
            o = int(r['atk_survivor'])
            if 1 <= o <= a-1: occ[(a, d)][o] += 1
        elif (not cap) and r['def_survivor']:
            v = int(r['def_survivor'])
            if 0 <= v <= d: rem[(a, d)][v] += 1
    return cell, occ, rem

def joint_nll(f, data):
    """Full joint negative-log-likelihood: outcome + conditional survivor counts."""
    cell, occ, rem = data; EPS = 1e-7; nll = 0.0
    for (a, d), (c, n) in cell.items():
        p = min(max(f(a, d)[0], EPS), 1-EPS); nll -= c*math.log(p)+(n-c)*math.log(1-p)
    for (a, d), h in occ.items():
        pc, od, _ = f(a, d); pc = max(pc, EPS)
        for k, cnt in h.items(): nll -= cnt*math.log(max(od.get(k, 0)/pc, EPS))
    for (a, d), h in rem.items():
        pc, _, rd = f(a, d); q = max(1-pc, EPS)
        for k, cnt in h.items(): nll -= cnt*math.log(max(rd.get(k, 0)/q, EPS))
    return nll

def _floor(data):
    """Saturated/empirical NLL — the best any model could do in-sample."""
    cell, occ, rem = data; nll = 0.0
    for (a, d), (c, n) in cell.items():
        p = c/n
        if 0 < p < 1: nll -= c*math.log(p)+(n-c)*math.log(1-p)
    for hh in (occ, rem):
        for (a, d), h in hh.items():
            t = sum(h.values())
            for k, cnt in h.items(): nll -= cnt*math.log(cnt/t)
    return nll

def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/all_battles.csv'
    data = load_cells(csv_path)
    fl = _floor(data)
    print(f'empirical noise floor (best possible in-sample): {fl:8.0f}\n')
    print(f'{"model":<32}{"joint NLL":>11}{"excess":>9}')
    for name, f in [('shipped closed form', closed_form_dp()),
                    ('pure iterated loop', loop_dp()),
                    ('HYBRID (loop + hinge remnant)', hybrid_dp())]:
        nll = joint_nll(f, data)
        print(f'{name:<32}{nll:>11.0f}{nll-fl:>+9.0f}')
    print('\n(lower is better; HYBRID is the best-fitting model overall.)')

if __name__ == '__main__':
    main()
