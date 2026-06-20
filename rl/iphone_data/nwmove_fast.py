#!/usr/bin/env python3
"""Bridge: parsed screenshot state -> ONE best RED move via the FAST C UCT.

Counterpart to nwmove.js / nwmove_nn.py, but runs the C open-loop PUCT search
(fast_engine.so via fastnw) with the tuned ranked rollout policy and NO neural
net (pure MCTS). This is the ~78-80% seed-free config from rl/ALPHAGO.md.

Reads a state JSON (from parse.py) on argv[1]. Builds adjacency = 8-connectivity
among surviving grid cells (the engine's lattice), runs the C UCT search, and
reports RED's single best action:
  {"action":"attack","from":id,"to":id,"fromPx":[x,y],"toPx":[x,y]}  or  {"action":"stop"}

Usage: nwmove_fast.py state.json [--sims 8000] [--wset C1] [--c-puct 2.5]
                       [--nroll 1] [--policy 1] [--turns N]
"""
import argparse
import json
import os
import sys

import numpy as np

RL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RL_DIR)

import network_wars as nw
from network_wars import HUMAN, State, Node as GNode
import fastnw
from fmcts import WSETS


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
    s.rng = None
    s.policy_rng = None
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('state')
    ap.add_argument('--sims', type=int, default=8000)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--wset', default='C1')
    ap.add_argument('--policy', type=int, default=1)
    ap.add_argument('--turns', type=int, default=1)
    ap.add_argument('--sim-seed', type=int, default=0x12345678)
    args = ap.parse_args()

    js = json.load(open(args.state))
    px = {n['id']: [n['px'], n['py']] for n in js['nodes']}
    state = build_state(js)

    # configure the C search exactly like fmcts best config (ranked rollout, no net)
    fastnw.set_topology(state)
    fastnw.set_red_rollout_policy(args.policy)
    if args.wset in WSETS:
        fastnw.set_ranked_weights(WSETS[args.wset])
    fastnw.set_heur_priors(0)            # pure UCT: uniform priors
    fastnw.set_roll_temp(0.0)
    fastnw.set_ensemble([])
    fastnw.use_sim(args.sim_seed)        # private seed-free sim rng (no seed exploitation)

    owner, strength = fastnw.board_arrays(state)
    acts, visits = fastnw.uct_search(owner, strength, args.turns, args.sims,
                                     args.c_puct, args.nroll, None)
    if len(acts) == 0:
        print(json.dumps({'action': 'stop'}))
        return
    action = int(acts[int(np.argmax(visits))])
    if action == -1:                     # END_TURN won the search
        print(json.dumps({'action': 'stop'}))
        return
    frm, to = action >> 8, action & 0xFF
    print(json.dumps({
        'action': 'attack', 'from': frm, 'to': to,
        'fromPx': px[frm], 'toPx': px[to],
    }))


if __name__ == '__main__':
    main()
