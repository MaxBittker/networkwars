#!/usr/bin/env python3
"""Fitted iOS battle function — the high-confidence reference, validated vs live data.

Derived from ~600 live single-battle observations (extract_battles.py) and the joint
outcome+survivor fit (fit_mechanic.py). The mechanic, replacing the shipped constant-p
iterated Bernoulli (network_wars.resolve_battle, ATTACKER_WIN_P=0.60):

  STRENGTH-PROPORTIONAL per-round dice. State (a, d), a>=1, d>=0. Each round:
      attacker wins w.p.  q = a^K / (a^K + C0 * d^K)   -> d -= 1
      else                                             -> a -= 1
  CAPTURE iff d reaches 0 while a >= 2 (one troop to occupy + one garrison):
      captured node gets (a-1); source node keeps 1.
  REPEL otherwise (attacker reduced to garrison a==1, incl. the spent-last-striker
      case where d also hit 0): source keeps 1; defender keeps its remnant. iOS does
      NOT flip ownership when the attacker is spent — the shipped engine wrongly does.

Fitted constants (n~600, stable across the last several hundred battles):
  K  ~ 0.62     per-round strength exponent
  C0 ~ 0.93     defender bias (~1: symmetric)
This reproduces the live CAPTURE survivors well (E[remnant] MAE ~0.8). It mildly
OVER-predicts REPEL survivors (model ~2.8 vs observed ~1.6) — real repelled defenders
are gutted toward garrison; `repel_defender_remnant` applies the empirical correction.

`drop_in_resolve_battle` shows the exact edit for network_wars.resolve_battle.
Run `python battle_model.py /tmp/all_battles.csv` to validate against collected data.
"""
import sys

K = 0.62
C0 = 0.93


def capture_prob_single(a, d, k=K, c0=C0):
    """Exact P(node captured) via DP over the strength-proportional ruin."""
    from functools import lru_cache

    @lru_cache(maxsize=None)
    def P(a, d):
        if a <= 1:
            return 0.0
        if d <= 0:
            return 1.0
        q = a ** k / (a ** k + c0 * d ** k)
        return q * P(a, d - 1) + (1 - q) * P(a - 1, d)

    return P(int(a), int(d))


def resolve_battle_ios(a, d, rng, k=K, c0=C0):
    """Play one iOS battle. `rng()` -> uniform [0,1). Returns
    (captured: bool, node_strength: int, source_strength: int)."""
    a0, d0 = a, d
    while a > 1 and d > 0:
        q = a ** k / (a ** k + c0 * d ** k)
        if rng() < q:
            d -= 1
        else:
            a -= 1
    if d == 0 and a >= 2:
        return True, a - 1, 1                 # capture: occupy with a-1, source keeps 1
    # repel: attacker spent to garrison (a==1). Defender remnant is NOT the raw
    # attrition d — the attacker's whole dying force still subtracted. Empirically
    # def ~ max(0, d0 - a0 + 1) (MAE 0.83 vs live, best of tested rules), mirroring
    # the capture rule (winner keeps the difference plus a garrison).
    return False, repel_defender_remnant(d0, a0), 1


def repel_defender_remnant(d0, a0):
    """Defender strength left after repelling: full-subtraction with a +1 garrison.
    Fitted to live repels (n=209): max(0, d0-a0+1) gives MAE 0.83 (vs 1.40 for the
    raw attrition remnant). Real repelled defenders are gutted to near garrison."""
    return max(0, d0 - a0 + 1)


def drop_in_resolve_battle():
    """The exact replacement for network_wars.resolve_battle (kept here, NOT applied
    to the live engine mid-collection). fast_engine.c gets the analogous change."""
    return '''
def resolve_battle(state, from_id, to_id):
    frm = state.nodes[from_id]; to = state.nodes[to_id]
    a = frm.strength; d = to.strength; rng = state.rng
    K, C0 = 0.62, 0.93
    a0, d0 = a, d
    while a > 1 and d > 0:
        q = a ** K / (a ** K + C0 * d ** K)
        if rng() < q: d -= 1
        else: a -= 1
    if d == 0 and a >= 2:          # capture requires a surviving occupier
        to.owner = frm.owner; to.strength = a - 1; frm.strength = 1
        return True
    frm.strength = 1               # spent to garrison; ownership unchanged (even if d==0)
    to.strength = max(0, d0 - a0 + 1)   # defender gutted by the full attacking force
    return False
'''


# ---------------------------------------------------------------- validation
def _mulberry(seed):
    s = seed & 0xFFFFFFFF
    def rng():
        nonlocal s
        s = (s + 0x6D2B79F5) & 0xFFFFFFFF
        t = s
        t = (t ^ (t >> 15)) * (t | 1) & 0xFFFFFFFF
        t ^= t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF) & 0xFFFFFFFF
        t &= 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return rng


def validate(path):
    import csv
    from collections import defaultdict
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
    print(f'validating fitted model (K={K}, C0={C0}) vs {len(rows)} live battles\n')

    # capture rate by margin: observed vs model (exact DP)
    b = defaultdict(lambda: [0, 0, 0.0])
    for a, d, cap, *_ in rows:
        m = max(-3, min(4, a - d))
        b[m][0] += cap; b[m][1] += 1; b[m][2] += capture_prob_single(a, d)
    print(f'{"a-d":>5}{"n":>6}{"obs%":>8}{"model%":>9}')
    tot_obs = tot_pred = 0
    for k in sorted(b):
        c, t, sp = b[k]
        print(f'{k:>+5}{t:>6}{c/t*100:>7.0f}{sp/t*100:>8.0f}')
        tot_obs += c; tot_pred += sp
    print(f'  overall capture: obs {tot_obs/len(rows)*100:.1f}%  model {tot_pred/len(rows)*100:.1f}%')

    # survivors: Monte-Carlo the model on each observed (a,d), compare means
    import statistics
    rng = _mulberry(12345)
    cap_obs, cap_pred, rep_obs, rep_pred = [], [], [], []
    for a, d, cap, asv, dsv in rows:
        # 200 sims per cell to estimate model survivor mean for this matchup
        cs, rs = [], []
        for _ in range(200):
            won, ns, _ = resolve_battle_ios(a, d, rng)
            (cs if won else rs).append(ns)
        if cap and asv is not None and cs:
            cap_obs.append(asv); cap_pred.append(statistics.mean(cs))
        if (not cap) and dsv is not None and rs:
            rep_obs.append(dsv); rep_pred.append(statistics.mean(rs))
    if cap_obs:
        mae = statistics.mean(abs(o - p) for o, p in zip(cap_obs, cap_pred))
        print(f'\nCAPTURE remnant (n={len(cap_obs)}): obs {statistics.mean(cap_obs):.2f} '
              f'model {statistics.mean(cap_pred):.2f}  MAE {mae:.2f}')
    if rep_obs:
        mae = statistics.mean(abs(o - p) for o, p in zip(rep_obs, rep_pred))
        print(f'REPEL  remnant (n={len(rep_obs)}): obs {statistics.mean(rep_obs):.2f} '
              f'model {statistics.mean(rep_pred):.2f}  MAE {mae:.2f}')


def _i(s):
    try:
        return int(s)
    except (ValueError, TypeError):
        return None


if __name__ == '__main__':
    validate(sys.argv[1] if len(sys.argv) > 1 else '/tmp/all_battles.csv')
