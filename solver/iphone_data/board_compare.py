#!/usr/bin/env python3
"""Compare REAL opening boards (from live logs) vs SIM-generated boards (make_game)
on structural features, to explain why real openings score lower offline (93% vs
97.5%) and to check the deal is balanced (totals ~20/faction = OCR is clean).
"""
import json, os, sys, statistics as st
from collections import Counter
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import network_wars as nw
from network_wars import HUMAN, FACTIONS, make_game

FILES = ['runs/series_20260622_prsearch.jsonl', 'runs/series_20260621_battle.jsonl',
         'runs/series_16k.jsonl', 'runs/series_20260621_200g.jsonl']


def adj_of(nodes):  # nodes: list of (id,row,col,owner,strength)
    pos = {(r, c): i for i, (r, c, o, s) in nodes.items()}
    A = {i: [] for i in nodes}
    for i, (r, c, o, s) in nodes.items():
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == dc == 0: continue
                j = pos.get((r + dr, c + dc))
                if j is not None: A[i].append(j)
    return A


def features(nodes):
    """nodes: {id:(row,col,owner,strength)}. Return feature dict for RED."""
    A = adj_of(nodes)
    red = [i for i in nodes if nodes[i][2] == HUMAN]
    # totals per faction
    tot = Counter(); cnt = Counter()
    for i, (r, c, o, s) in nodes.items():
        tot[o] += s; cnt[o] += 1
    # red largest connected component
    seen = set(); comps = []
    for i in red:
        if i in seen: continue
        stack = [i]; seen.add(i); comp = []
        while stack:
            x = stack.pop(); comp.append(x)
            for j in A[x]:
                if j in red and j not in seen: seen.add(j); stack.append(j)
        comps.append(comp)
    largest = max((len(c) for c in comps), default=0)
    # red exposure: # red nodes adjacent to >=1 enemy; avg enemy neighbors per red node
    exposed = sum(1 for i in red if any(nodes[j][2] != HUMAN for j in A[i]))
    enemy_nbrs = st.mean(sum(1 for j in A[i] if nodes[j][2] != HUMAN) for i in red) if red else 0
    # threats: # enemy nodes adjacent to red that are STRONGER than the red node
    threats = 0
    for i in red:
        for j in A[i]:
            if nodes[j][2] != HUMAN and nodes[j][3] > nodes[i][3]:
                threats += 1
    return {
        'red_total': tot[HUMAN], 'faction_total_spread': max(tot.values()) - min(tot.values()),
        'red_largest_comp': largest, 'red_ncomps': len(comps),
        'red_exposed': exposed, 'red_enemy_nbrs': enemy_nbrs, 'red_threats': threats,
    }


def real_boards():
    out = []
    for f in FILES:
        if not os.path.exists(f): continue
        for line in open(f):
            try: r = json.loads(line)
            except: continue
            if r.get('type') != 'game': continue
            traj = r.get('trajectory', [])
            if not traj: continue
            bb = traj[0].get('board_before')
            if not bb or len(bb) != 30 or any(n.get('s') is None for n in bb): continue
            cc = Counter(n['o'] for n in bb)
            if len(cc) != 5 or any(v != 6 for v in cc.values()): continue
            out.append({n['id']: (n['r'], n['c'], n['o'], n['s']) for n in bb})
    return out


def sim_boards(n):
    out = []
    for seed in range(1, n + 1):
        st_ = make_game(seed)
        out.append({nd.id: (nd.y, nd.x, nd.owner, nd.strength) for nd in st_.nodes})
    return out


def summarize(tag, boards):
    feats = [features(b) for b in boards]
    print(f"\n{tag}  (n={len(boards)})")
    for k in ['red_total', 'faction_total_spread', 'red_largest_comp', 'red_ncomps',
              'red_exposed', 'red_enemy_nbrs', 'red_threats']:
        vals = [f[k] for f in feats]
        print(f"  {k:<22} mean={st.mean(vals):6.2f}  median={st.median(vals):5.1f}  "
              f"sd={st.pstdev(vals):4.2f}")
    return feats


def main():
    rb = real_boards()
    sb = sim_boards(max(300, len(rb)))
    summarize("REAL opening boards", rb)
    summarize("SIM make_game boards", sb)
    print("\nKey: red_total should be ~20 both (clean OCR + balanced deal).")
    print("red_threats / red_exposed higher in REAL => real openings put red in contact")
    print("with more/stronger enemies => harder => explains the 97.5%->93% offline drop.")


if __name__ == '__main__':
    main()
