#!/usr/bin/env python3
"""Fit the iOS bot POLICY against historical bot-phase outcomes (no new live data).

For each live round transition we know:
  start    = red_post_board (board after red's attacks, before End Turn)
  actual   = next round's board_before (board after the FULL bot phase:
             red-reinforce + green/yellow/blue/purple each attack+reinforce)

We replay the bot phase from `start` under a CANDIDATE bot policy, K times with
different dice (battle model FIXED = calibrated power-ratio), and score how well the
simulated end-board distribution matches the real `actual`. The battle dice are the
same for every candidate, so differences in score are attributable to POLICY
(threshold + target selection + tie-break + the resulting cross-faction cascades).

Metrics per candidate (lower NLL / higher acc / lower MAE = closer to reality):
  ownNLL   : mean per-node negative log-likelihood of the actual owner
  modalAcc : fraction of nodes whose modal predicted owner == actual owner
  redLossF1: F1 of predicting WHICH red nodes a bot captures this phase
  cntMAE   : mean abs error of per-faction node counts (5 factions)
ORACLE row = baseline policy scored against a HELD-OUT baseline sample instead of
reality -> the irreducible dice floor (best any policy could score if baseline were
the true bot).

This tests only strict-downhill policies, matching the observed iOS rule that
bots do not attack equal/uphill targets.

Usage: python bot_policy_fit.py [--ksim 50] [--max-round 6] [--workers 9]
"""
import argparse, json, math, os, sys
from collections import Counter
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import network_wars as nw
from network_wars import HUMAN, FACTIONS
import nwmove_fast as NWM

BOTS = [f for f in FACTIONS if f != HUMAN]
K, C0 = 0.62, 0.93


# NOTE: the engine now runs the bots + battle in C (fast_engine.c), so we can no
# longer monkeypatch nw.best_bot_move / nw.resolve_battle. Instead we replay the bot
# phase in pure Python here (run_bot_turn below) with a bring-your-own policy/battle,
# operating directly on the State's Node objects. nw.reinforce/check_winner/counts
# are reused (they read the current nodes; reinforce is deterministic).
def corrected_resolve_battle(state, from_id, to_id):
    """Pure-Python power-ratio battle using state.rng (the experiment's own stream)."""
    frm = state.nodes[from_id]; to = state.nodes[to_id]
    a = frm.strength; d = to.strength; rng = state.rng
    a0, d0 = a, d
    while a > 1 and d > 0:
        q = a ** K / (a ** K + C0 * d ** K)
        if rng() < q: d -= 1
        else: a -= 1
    if d == 0 and a >= 2:
        to.owner = frm.owner; to.strength = a - 1; frm.strength = 1
        return True
    frm.strength = 1; to.strength = max(0, d0 - a0 + 1)
    return False


def run_bot_turn(state, faction, policy_fn, reinforce_fn=nw.reinforce):
    """One bot turn: attack via policy_fn (returns (frm,to)|None) + corrected battle
    to exhaustion, then reinforce_fn. Operates on the Python nodes (no C bots)."""
    if nw.counts(state)[faction] == 0:
        return
    g = 0
    while g < 1000:
        g += 1
        mv = policy_fn(state, faction)
        if mv is None:
            break
        corrected_resolve_battle(state, mv[0], mv[1])
        if nw.check_winner(state) is not None:
            return
    reinforce_fn(state, faction)


def mulberry(seed):
    s = seed & 0xFFFFFFFF
    def rng():
        nonlocal s
        s = (s + 0x6D2B79F5) & 0xFFFFFFFF
        t = s
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return (((t ^ (t >> 14)) & 0xFFFFFFFF)) / 4294967296.0
    return rng


# ---- candidate policies: each returns a (frm_id, to_id) or None -------------
def make_policy(threshold, rank):
    """threshold: min allowed margin (n.s - t.s).  rank: key fn (n,t,margin)->tuple to MINIMIZE."""
    def fn(state, faction):
        best = None; bk = None
        for n in state.nodes:
            if n.owner != faction or n.strength <= 1:
                continue
            for nb in state.adj[n.id]:
                t = state.nodes[nb]
                if t.owner == faction:
                    continue
                m = n.strength - t.strength
                if m < threshold:
                    continue
                k = rank(n, t, m)
                if best is None or k < bk:
                    best = (n.id, nb); bk = k
        return best
    return fn


def _is_red(t):
    return 0 if t.owner == HUMAN else 1


POLICIES = {
    # name: (threshold, rank)  -- baseline = OLD best_bot_move (weakest target first)
    'baseline_strict':   (1,  lambda n, t, m: (t.strength, -n.strength, n.id, t.id)),
    # attacker_first = NOW-SHIPPED ordering: strongest source node first, then its
    # weakest reachable target (max's observed iOS rule; 7->6 before 5->1).
    'attacker_first':    (1,  lambda n, t, m: (-n.strength, t.strength, n.id, t.id)),
    # selection variants (strict threshold, isolate target/source choice)
    'strict_maxmargin':  (1,  lambda n, t, m: (-m, t.strength, n.id, t.id)),
    'strict_maxmargin_strongsrc': (1, lambda n, t, m: (-m, -n.strength, t.strength, n.id, t.id)),
    'strict_ratio':      (1,  lambda n, t, m: (-(n.strength / max(1, t.strength)), t.strength, -n.strength, n.id, t.id)),
    'strict_minmargin':  (1,  lambda n, t, m: (m, t.strength, n.id, t.id)),
    'strict_weaksrc':    (1,  lambda n, t, m: (t.strength,  n.strength, n.id, t.id)),
    'strict_low_target_id': (1, lambda n, t, m: (t.strength, t.id, -n.strength, n.id)),
    'strict_preferred_red': (1, lambda n, t, m: (_is_red(t), t.strength, -n.strength, n.id, t.id)),
}


def board_red_post(turn):
    last = None
    for mv in turn.get('moves', []):
        if mv.get('result') == 'applied' and mv.get('board_after'):
            last = mv['board_after']
    last = last or turn.get('board_before')
    if not last:
        return None
    return {'nodes': [{'id': n['id'], 'row': n['r'], 'col': n['c'], 'owner': n['o'],
                       'strength': n['s'] if n['s'] is not None else 1} for n in last]}


def sim_phase(board, policy_fn, seed):
    st = NWM.build_state(board)
    st.rng = mulberry(seed)
    nw.reinforce(st, HUMAN)                    # red reinforce (baseline, deterministic)
    for b in BOTS:
        run_bot_turn(st, b, policy_fn)         # candidate policy + corrected battle
    return {n.id: n.owner for n in st.nodes}


def stable_hash(text):
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def score_chunk(arg):
    items, names, ksim = arg
    # accumulators per policy
    acc = {nm: {'nll': 0.0, 'modal_ok': 0, 'nodes': 0,
                'tp': 0, 'fp': 0, 'fn': 0, 'cnt_mae': 0.0, 'trans': 0} for nm in names + ['ORACLE']}
    alpha = 0.5
    for board, actual, red_start in items:
        for nm in names:
            pol = make_policy(*POLICIES[nm])
            dist = {nid: Counter() for nid in actual}
            for k in range(ksim):
                seed = 0x9E3779B9 ^ (k * 2654435761) ^ stable_hash(nm)
                res = sim_phase(board, pol, seed & 0xFFFFFFFF)
                for nid, ow in res.items():
                    dist[nid][ow] += 1
            a = acc[nm]
            a['trans'] += 1
            # per-faction count mae
            sim_counts = Counter()
            for nid in actual:
                sim_counts[dist[nid].most_common(1)[0][0]] += 1
            act_counts = Counter(actual.values())
            a['cnt_mae'] += sum(abs(sim_counts[f] - act_counts.get(f, 0)) for f in FACTIONS) / len(FACTIONS)
            for nid, ow_actual in actual.items():
                c = dist[nid]; tot = sum(c.values())
                p = (c[ow_actual] + alpha) / (tot + alpha * len(FACTIONS))
                a['nll'] += -math.log(p)
                modal = c.most_common(1)[0][0]
                a['modal_ok'] += (modal == ow_actual)
                a['nodes'] += 1
                # red-loss prediction (only for nodes red owned at start)
                if nid in red_start:
                    actual_lost = ow_actual != HUMAN
                    pred_lost = modal != HUMAN
                    if pred_lost and actual_lost: a['tp'] += 1
                    elif pred_lost and not actual_lost: a['fp'] += 1
                    elif not pred_lost and actual_lost: a['fn'] += 1
        # ORACLE: baseline scored vs a held-out baseline sample (dice floor)
        pol = make_policy(*POLICIES['baseline_strict'])
        dist = {nid: Counter() for nid in actual}
        for k in range(ksim):
            res = sim_phase(board, pol, 0xABCDEF ^ (k * 40503))
            for nid, ow in res.items():
                dist[nid][ow] += 1
        held = sim_phase(board, pol, 0x5555 ^ 12345)  # one more independent sample = "reality"
        a = acc['ORACLE']; a['trans'] += 1
        sim_counts = Counter(dist[nid].most_common(1)[0][0] for nid in actual)
        held_counts = Counter(held.values())
        a['cnt_mae'] += sum(abs(sim_counts[f] - held_counts.get(f, 0)) for f in FACTIONS) / len(FACTIONS)
        for nid in actual:
            c = dist[nid]; tot = sum(c.values()); ow_h = held[nid]
            p = (c[ow_h] + alpha) / (tot + alpha * len(FACTIONS))
            a['nll'] += -math.log(p); a['nodes'] += 1
            a['modal_ok'] += (c.most_common(1)[0][0] == ow_h)
    return acc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ksim', type=int, default=50)
    ap.add_argument('--max-round', type=int, default=6)
    ap.add_argument('--workers', type=int, default=9)
    ap.add_argument('--limit', type=int, default=0, help='cap transitions (0=all)')
    ap.add_argument('files', nargs='*', default=[
        'runs/series_20260621_battle.jsonl', 'runs/series_20260622_prsearch.jsonl',
        'runs/series_16k.jsonl', 'runs/series_20260621_200g.jsonl'])
    args = ap.parse_args()

    items = []
    for f in args.files:
        if not os.path.exists(f):
            continue
        for line in open(f):
            try: r = json.loads(line)
            except: continue
            if r.get('type') != 'game': continue
            traj = r.get('trajectory', [])
            for i in range(len(traj) - 1):
                rnd = traj[i].get('round')
                if rnd is None or rnd > args.max_round: continue
                board = board_red_post(traj[i])
                nxt = traj[i + 1].get('board_before')
                if not board or not nxt or len(board['nodes']) != 30 or len(nxt) != 30:
                    continue
                actual = {n['id']: n['o'] for n in nxt}
                red_start = {n['id'] for n in board['nodes'] if n['owner'] == HUMAN}
                items.append((board, actual, red_start))
    if args.limit:
        items = items[:args.limit]
    names = list(POLICIES.keys())
    print(f"scoring {len(items)} transitions x {len(names)} policies, ksim={args.ksim}, "
          f"rounds 0-{args.max_round}", flush=True)
    chunks = [items[i::args.workers] for i in range(args.workers)]
    tasks = [(c, names, args.ksim) for c in chunks if c]
    with Pool(args.workers) as pool:
        parts = pool.map(score_chunk, tasks)
    # merge
    agg = parts[0]
    for p in parts[1:]:
        for nm, d in p.items():
            for kk, vv in d.items():
                agg[nm][kk] += vv

    rows = []
    for nm in names + ['ORACLE']:
        a = agg[nm]
        nll = a['nll'] / max(1, a['nodes'])
        macc = a['modal_ok'] / max(1, a['nodes'])
        mae = a['cnt_mae'] / max(1, a['trans'])
        if nm != 'ORACLE':
            prec = a['tp'] / max(1, a['tp'] + a['fp'])
            rec = a['tp'] / max(1, a['tp'] + a['fn'])
            f1 = 2 * prec * rec / max(1e-9, prec + rec)
        else:
            f1 = float('nan')
        rows.append((nm, nll, macc, f1, mae))

    print(f"\n{'policy':<22}{'ownNLL':>9}{'modalAcc':>10}{'redLossF1':>11}{'cntMAE':>9}")
    base = [r for r in rows if r[0] == 'baseline_strict'][0]
    for nm, nll, macc, f1, mae in rows:
        tag = '  <- baseline' if nm == 'baseline_strict' else ('  (dice floor)' if nm == 'ORACLE' else '')
        d = f"  dNLL={nll-base[1]:+.3f}" if nm not in ('baseline_strict', 'ORACLE') else ''
        print(f"{nm:<22}{nll:>9.3f}{macc*100:>9.1f}%{f1:>11.3f}{mae:>9.3f}{d}{tag}")
    print("\nLower ownNLL & cntMAE, higher modalAcc/redLossF1 = closer to real bots.")
    print("ORACLE = baseline-vs-baseline dice floor; any policy near it has fit the noise ceiling.")


if __name__ == '__main__':
    main()
