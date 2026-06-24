#!/usr/bin/env python3
"""Bridge: parsed screenshot state -> ONE best RED move via the FAST C UCT.

Runs the C open-loop PUCT search (fast_engine.so via fastnw): pure MCTS with the
baked-in ranked C1 rollout policy and no neural net.

Reads a state JSON (from parse.py) on argv[1]. Builds adjacency = 8-connectivity
among surviving grid cells (the engine's lattice), runs the C UCT search, and
reports RED's single best action:
  {"action":"attack","from":id,"to":id,"fromPx":[x,y],"toPx":[x,y]}  or  {"action":"stop"}

Usage: nwmove_fast.py state.json [--sims 8000] [--c-puct 2.5] [--nroll 1] [--turns N]
"""
import argparse
import json
import os
import sys

import numpy as np

SOLVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SOLVER_DIR)

from network_wars import State, Node as GNode
import fastnw


def build_state(js):
    """network_wars.State from a parsed iOS board JSON (8-connectivity lattice)."""
    nodes = [GNode(n['id'], n['col'], n['row'], n['owner'], n['strength'])
             for n in js['nodes']]
    n = len(nodes)
    adj = [[] for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            if abs(nodes[i].x - nodes[j].x) <= 1 and abs(nodes[i].y - nodes[j].y) <= 1:
                adj[i].append(j)
                adj[j].append(i)
    s = State()
    s.nodes, s.adj, s.links = nodes, adj, []
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('state')
    ap.add_argument('--sims', type=int, default=8000)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--wset', default='C1', help='accepted for back-compat; ignored (C1 baked in)')
    ap.add_argument('--policy', type=int, default=1, help='accepted for back-compat; ignored')
    ap.add_argument('--turns', type=int, default=1)
    ap.add_argument('--sim-seed', type=int, default=0x12345678)
    args = ap.parse_args()

    js = json.load(open(args.state))
    px = {n['id']: [n['px'], n['py']] for n in js['nodes']}
    state = build_state(js)

    # pure C-UCT with the baked-in ranked C1 rollout policy (no neural net)
    fastnw.set_topology(state)
    fastnw.use_sim(args.sim_seed)        # private seed-free sim rng (no seed exploitation)
    owner, strength = fastnw.board_arrays(state)
    acts, visits, q = fastnw.uct_search(owner, strength, args.turns, args.sims,
                                        args.c_puct, args.nroll, return_q=True)
    if len(acts) == 0:
        print(json.dumps({'action': 'stop', 'winexp': None}))
        return
    best = int(np.argmax(visits))
    action = int(acts[best])
    tv = int(visits.sum())
    # winexp = the single RED win-prob readout: the search's backed-up Q of the
    # chosen move. AUC ~0.955 vs real outcomes (it falls out of the MCTS itself).
    winexp = float(q[best])

    # top candidate moves (for the dashboard search-tree panel)
    nodes_by_id = {n['id']: n for n in js['nodes']}
    order = np.argsort(-visits)[:14]
    top = []
    for k in order:
        a = int(acts[k])
        if a == -1:
            top.append({'action': -1, 'from': None, 'to': None, 'label': 'END TURN',
                        'from_owner': None, 'to_owner': None, 'visits': int(visits[k]),
                        'frac': float(visits[k] / tv) if tv else 0.0, 'q': float(q[k])})
            continue
        f, t = a >> 8, a & 0xFF
        nf, nt = nodes_by_id.get(f), nodes_by_id.get(t)
        lbl = (f"{nf['owner'][0].upper()}{nf['strength']}→{nt['owner'][0].upper()}{nt['strength']}"
               if nf and nt else '?')
        top.append({'action': a, 'from': f, 'to': t, 'label': lbl,
                    'from_owner': nf['owner'] if nf else None,
                    'to_owner': nt['owner'] if nt else None,
                    'visits': int(visits[k]), 'frac': float(visits[k] / tv) if tv else 0.0,
                    'q': float(q[k])})

    if action == -1:                     # END_TURN won the search
        print(json.dumps({'action': 'stop', 'winexp': winexp,
                          'visits': tv, 'top': top}))
        return
    frm, to = action >> 8, action & 0xFF
    print(json.dumps({
        'action': 'attack', 'from': frm, 'to': to,
        'fromPx': px[frm], 'toPx': px[to],
        'winexp': winexp, 'visits': tv, 'moveVisits': int(visits[best]), 'top': top,
    }))


if __name__ == '__main__':
    main()
