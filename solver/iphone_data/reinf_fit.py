#!/usr/bin/env python3
"""Test REINFORCEMENT-model variants against historical bot-phase outcomes.

Keeps the baseline strictly-greedy best_bot_move (shown best by bot_policy_fit) and
varies only nw.reinforce, scoring per-node ownership NLL / modal accuracy / count
MAE the same way as bot_policy_fit. Reinforcement shapes which nodes resist capture,
so a better reinforce model can lower the residual gap to the dice floor.

Usage: python reinf_fit.py [--ksim 40] [--max-round 6] [--limit 900]
"""
import argparse, json, math, os, sys
from collections import Counter
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import network_wars as nw
from network_wars import HUMAN, FACTIONS
import nwmove_fast as NWM
import bot_policy_fit as BPF   # reuse board_red_post, mulberry, corrected battle, make_policy

BOTS = [f for f in FACTIONS if f != HUMAN]
BASE_MOVE = BPF.make_policy(*BPF.POLICIES['baseline_strict'])


# ---- reinforce variants ------------------------------------------------------
def _border(state, comp, faction):
    return sorted(nid for nid in comp
                  if any(state.nodes[nb].owner != faction for nb in state.adj[nid]))


def r_baseline(state, faction):
    comps = nw.components_of(state, faction)
    if not comps: return
    largest = max(comps, key=len)
    border = _border(state, largest, faction)
    if not border: return
    for i in range(len(largest)):
        state.nodes[border[i % len(border)]].strength += 1


def r_all_comps(state, faction):
    """Each component reinforces its own border by its own size."""
    for comp in nw.components_of(state, faction):
        border = _border(state, comp, faction)
        if not border: continue
        for i in range(len(comp)):
            state.nodes[border[i % len(border)]].strength += 1


def r_total_on_largest(state, faction):
    """Amount = TOTAL faction nodes, all spread on the largest component's border."""
    comps = nw.components_of(state, faction)
    if not comps: return
    largest = max(comps, key=len)
    border = _border(state, largest, faction)
    if not border: return
    total = sum(len(c) for c in comps)
    for i in range(total):
        state.nodes[border[i % len(border)]].strength += 1


def r_concentrate(state, faction):
    """Largest comp, amount=len(largest), but pile onto the SINGLE weakest border node
    (front-load a strong spearhead) instead of spreading."""
    comps = nw.components_of(state, faction)
    if not comps: return
    largest = max(comps, key=len)
    border = _border(state, largest, faction)
    if not border: return
    amt = len(largest)
    border.sort(key=lambda nid: state.nodes[nid].strength)
    # pile on the weakest, then next, round-robin weakest-first by repeated passes
    for i in range(amt):
        state.nodes[border[i % len(border)]].strength += 1  # border sorted weakest-first


REINF = {
    'baseline': r_baseline,
    'all_comps': r_all_comps,
    'total_on_largest': r_total_on_largest,
    'concentrate_weakest': r_concentrate,
}


def sim_phase(board, reinf_fn, seed):
    st = NWM.build_state(board)
    st.rng = BPF.mulberry(seed)
    reinf_fn(st, HUMAN)                                  # red reinforce (variant)
    for b in BOTS:
        BPF.run_bot_turn(st, b, BASE_MOVE, reinf_fn)     # baseline policy + variant reinforce
    return {n.id: n.owner for n in st.nodes}


def score_chunk(arg):
    items, names, ksim = arg
    acc = {nm: {'nll': 0.0, 'ok': 0, 'nodes': 0, 'mae': 0.0, 'trans': 0} for nm in names}
    alpha = 0.5
    for board, actual in items:
        for nm in names:
            dist = {nid: Counter() for nid in actual}
            for k in range(ksim):
                res = sim_phase(board, REINF[nm], 0x9E3779B9 ^ (k * 2654435761))
                for nid, ow in res.items():
                    dist[nid][ow] += 1
            a = acc[nm]; a['trans'] += 1
            simc = Counter(dist[nid].most_common(1)[0][0] for nid in actual)
            actc = Counter(actual.values())
            a['mae'] += sum(abs(simc[f] - actc.get(f, 0)) for f in FACTIONS) / len(FACTIONS)
            for nid, ow in actual.items():
                c = dist[nid]; tot = sum(c.values())
                a['nll'] += -math.log((c[ow] + alpha) / (tot + alpha * len(FACTIONS)))
                a['ok'] += (c.most_common(1)[0][0] == ow); a['nodes'] += 1
    return acc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ksim', type=int, default=40)
    ap.add_argument('--max-round', type=int, default=6)
    ap.add_argument('--workers', type=int, default=9)
    ap.add_argument('--limit', type=int, default=900)
    ap.add_argument('files', nargs='*', default=[
        'runs/series_20260621_battle.jsonl', 'runs/series_20260622_prsearch.jsonl',
        'runs/series_16k.jsonl', 'runs/series_20260621_200g.jsonl'])
    a = ap.parse_args()

    items = []
    for f in a.files:
        if not os.path.exists(f): continue
        for line in open(f):
            try: r = json.loads(line)
            except: continue
            if r.get('type') != 'game': continue
            traj = r.get('trajectory', [])
            for i in range(len(traj) - 1):
                rnd = traj[i].get('round')
                if rnd is None or rnd > a.max_round: continue
                board = BPF.board_red_post(traj[i]); nxt = traj[i + 1].get('board_before')
                if not board or not nxt or len(board['nodes']) != 30 or len(nxt) != 30: continue
                items.append((board, {n['id']: n['o'] for n in nxt}))
    if a.limit: items = items[:a.limit]
    names = list(REINF.keys())
    print(f"scoring {len(items)} transitions x {len(names)} reinforce variants, ksim={a.ksim}", flush=True)
    chunks = [items[i::a.workers] for i in range(a.workers)]
    with Pool(a.workers) as pool:
        parts = pool.map(score_chunk, [(c, names, a.ksim) for c in chunks if c])
    agg = parts[0]
    for p in parts[1:]:
        for nm, d in p.items():
            for k, v in d.items(): agg[nm][k] += v
    print(f"\n{'reinforce':<22}{'ownNLL':>9}{'modalAcc':>10}{'cntMAE':>9}")
    base = agg['baseline']['nll'] / max(1, agg['baseline']['nodes'])
    for nm in names:
        a_ = agg[nm]; nll = a_['nll'] / max(1, a_['nodes'])
        print(f"{nm:<22}{nll:>9.3f}{a_['ok']/max(1,a_['nodes'])*100:>9.1f}%{a_['mae']/max(1,a_['trans']):>9.3f}"
              f"{'' if nm=='baseline' else f'  dNLL={nll-base:+.3f}'}")


if __name__ == '__main__':
    main()
