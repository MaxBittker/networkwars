#!/usr/bin/env python3
"""WHAT are the real iOS bots doing that best_bot_move doesn't?

For each early-round transition we have red_post (board after red's attacks, with
strengths) and the actual next board (after the real bot phase). We:
  1. find every red node that a BOT captured in reality, and
  2. classify HOW, by the situation at red_post:
       greedy-legal : some bot neighbor had STRICTLY-greater strength
                      -> best_bot_move would take it too (not "extra").
       equal-only   : strongest bot neighbor EQUALED the red node's strength
                      -> best_bot_move SKIPS (needs strictly >), real bot took it.
       weaker-only  : strongest bot neighbor was WEAKER than the red node
                      -> real bot attacked uphill, or chained/softened across the turn.
       no-bot-nbr   : no bot neighbor at all at red_post -> only reachable via a
                      chain (a bot captured an adjacent node first, then this).
  3. also Monte-Carlo the sim bot phase and report, per class, how often the SIM
     actually took that same node (to confirm "equal/weaker/no-nbr" are the ones
     the sim under-takes).

equal-only / weaker-only / no-bot-nbr captures are concrete examples of real bots
punishing harder than our greedy strictly-stronger model.

Usage: python bot_behavior_diff.py [--max-round 2] [--ksim 80]
"""
import argparse, json, os, sys
from collections import Counter, defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import network_wars as nw
from network_wars import HUMAN, FACTIONS
import nwmove_fast as NWM

K, C0 = 0.62, 0.93
BOTS = [f for f in FACTIONS if f != HUMAN]


def corrected_resolve_battle(state, from_id, to_id):
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
nw.resolve_battle = corrected_resolve_battle


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


def board_js(turn):
    last = None
    for m in turn.get('moves', []):
        if m.get('result') == 'applied' and m.get('board_after'):
            last = m['board_after']
    if last is None:
        last = turn.get('board_before')
    if last is None:
        return None
    return {'nodes': [{'id': n['id'], 'row': n['r'], 'col': n['c'],
                       'owner': n['o'], 'strength': n['s'] if n['s'] is not None else 1}
                      for n in last]}


def adj_of(nodes):
    A = {n['id']: [] for n in nodes}
    pos = {(n['row'], n['col']): n['id'] for n in nodes}
    for n in nodes:
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0: continue
                j = pos.get((n['row'] + dr, n['col'] + dc))
                if j is not None: A[n['id']].append(j)
    return A


def sim_takes(board, ksim):
    """Fraction of ksim sim bot phases in which each red node ends bot-owned."""
    red0 = [n['id'] for n in board['nodes'] if n['owner'] == 'red']
    taken = Counter()
    for k in range(ksim):
        st = NWM.build_state(board)
        st.rng = mulberry(0x1234567 ^ (k * 2654435761))
        nw.reinforce(st, HUMAN)
        for b in BOTS:
            nw.run_bot_turn(st, b)
        for nid in red0:
            if st.nodes[nid].owner != HUMAN:
                taken[nid] += 1
    return {nid: taken[nid] / ksim for nid in red0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-round', type=int, default=2)
    ap.add_argument('--ksim', type=int, default=80)
    ap.add_argument('--only-losses', action='store_true')
    ap.add_argument('files', nargs='*', default=[
        'runs/series_20260621_battle.jsonl', 'runs/series_20260622_prsearch.jsonl'])
    args = ap.parse_args()

    cls = Counter()
    sim_rate_by_cls = defaultdict(list)
    examples = defaultdict(list)
    for f in args.files:
        for line in open(f):
            r = json.loads(line)
            if r.get('type') != 'game': continue
            if args.only_losses and r.get('result') != 'loss': continue
            traj = r.get('trajectory', [])
            for i in range(len(traj) - 1):
                rnd = traj[i].get('round')
                if rnd is None or rnd > args.max_round: continue
                b = board_js(traj[i])
                if not b or len(b['nodes']) != 30: continue
                nxt = traj[i + 1].get('board_before')
                if not nxt: continue
                nxt_owner = {n['id']: n['o'] for n in nxt}
                idx = {n['id']: n for n in b['nodes']}
                A = adj_of(b['nodes'])
                simr = sim_takes(b, args.ksim)
                for n in b['nodes']:
                    if n['owner'] != 'red': continue
                    nid = n['id']
                    if nxt_owner.get(nid) in (None, 'red'): continue  # not captured by a bot
                    ds = n['strength']
                    botn = [idx[j] for j in A[nid] if idx[j]['owner'] in BOTS]
                    if not botn:
                        c = 'no-bot-nbr'
                    else:
                        mx = max(x['strength'] for x in botn)
                        c = 'greedy-legal' if mx > ds else ('equal-only' if mx == ds else 'weaker-only')
                    cls[c] += 1
                    sim_rate_by_cls[c].append(simr.get(nid, 0.0))
                    if c != 'greedy-legal' and len(examples[c]) < 6:
                        examples[c].append(
                            f"g{r.get('game_index')} r{rnd} node{nid}(red s{ds}) -> {nxt_owner[nid]}; "
                            f"bot nbrs={sorted((idx[j]['owner'][:1], idx[j]['strength']) for j in A[nid] if idx[j]['owner'] in BOTS)}; "
                            f"sim-took={simr.get(nid,0)*100:.0f}%")

    import statistics as st
    tot = sum(cls.values())
    print(f"red nodes captured by bots in rounds 0-{args.max_round}"
          f"{' (losses only)' if args.only_losses else ''}: {tot}\n")
    print(f"{'class':<14}{'n':>5}{'share':>8}{'avg sim-took%':>15}")
    for c in ['greedy-legal', 'equal-only', 'weaker-only', 'no-bot-nbr']:
        if cls[c]:
            sr = st.mean(sim_rate_by_cls[c]) * 100
            print(f"{c:<14}{cls[c]:>5}{cls[c]/tot*100:>7.0f}%{sr:>14.0f}%")
    print("\n  greedy-legal: best_bot_move takes it too (not extra).")
    print("  equal-only/weaker-only/no-bot-nbr: real bot took a node best_bot_move would NOT")
    print("  attack head-on; low sim-took% = the sim under-captures these = harder real punishment.\n")
    for c in ['equal-only', 'weaker-only', 'no-bot-nbr']:
        if examples[c]:
            print(f"examples [{c}]:")
            for e in examples[c]:
                print("   " + e)


if __name__ == '__main__':
    main()
