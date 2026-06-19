#!/usr/bin/env python3
"""Bridge: parsed screenshot state -> ONE best RED move via the NEURAL MCTS.

The counterpart to nwmove.js, but instead of the JS flat mcts.js it runs the
Python PUCT search from mcts.py guided by a trained net (default sl_cnn.pt).

Reads a state JSON (from parse.py) on argv[1]. Builds a network_wars.State from
the parsed nodes (adjacency = 8-connectivity among surviving grid cells, the
engine's lattice), runs mcts_search, and reports RED's single best action:
  {"action":"attack","from":id,"to":id,"fromPx":[x,y],"toPx":[x,y]}  or  {"action":"stop"}

Usage: nwmove_nn.py state.json [--sims 100] [--checkpoint sl_cnn.pt]
                     [--policy policy_cnn] [--turns N]
"""
import argparse
import importlib
import json
import os
import sys

RL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RL_DIR)

import torch

import network_wars as nw
from network_wars import HUMAN, DIRS, END_TURN, GRID_COLS, State, Node as GNode
import mcts as M


def build_state(js):
    """Construct a network_wars.State from a parsed iOS board JSON."""
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
    ap.add_argument('--sims', type=int, default=100)
    ap.add_argument('--checkpoint', default=os.path.join(RL_DIR, 'sl_cnn.pt'))
    ap.add_argument('--policy', default='policy_cnn')
    ap.add_argument('--c-puct', type=float, default=1.5)
    ap.add_argument('--turns', type=int, default=1)
    args = ap.parse_args()

    js = json.load(open(args.state))
    px = {n['id']: [n['px'], n['py']] for n in js['nodes']}
    state = build_state(js)
    c2id = M.coord_map(state)

    from evaluate import _EnvShim
    policy = importlib.import_module(args.policy).Policy(_EnvShim(nw.OBS_DIM))
    policy.load_state_dict(torch.load(args.checkpoint, map_location='cpu'))
    policy.eval()
    ev = M.Evaluator(policy)

    legal = M.legal_action_indices(state, c2id)
    if len(legal) == 1:                       # only END_TURN available
        print(json.dumps({'action': 'stop'}))
        return
    root = M.mcts_search(state, args.turns, ev, c2id, args.sims, args.c_puct)
    action = M.best_action(root, legal, by='visits')

    if action == END_TURN:
        print(json.dumps({'action': 'stop'}))
        return
    cell, d = divmod(int(action), len(DIRS))
    y, x = divmod(cell, GRID_COLS)
    dy, dx = DIRS[d]
    frm = c2id.get((y, x))
    to = c2id.get((y + dy, x + dx))
    print(json.dumps({
        'action': 'attack', 'from': frm, 'to': to,
        'fromPx': px[frm], 'toPx': px[to],
    }))


if __name__ == '__main__':
    main()
