#!/usr/bin/env python3
"""Root-parallel C-UCT move: a drop-in for nwmove_fast.py that fans the search
across CPU cores. The live loop is phone-bottlenecked (CPU sits idle during taps
+ board-reads), so this buys DEEPER search at ~the same wall-clock, not faster
games.

Root parallelization: K worker processes each run an INDEPENDENT full search with
a distinct sim-seed (the engine's search RNG is a per-process splitmix64 global,
so forked children are independent). We sum per-action visit counts across workers
and visit-weight the per-action Q. Effective search ≈ K * --sims sims of work
(an ensemble — stronger than a single --sims search, though not identical to a
single K*--sims search since the trees aren't shared).

Output JSON is byte-compatible with nwmove_fast.py (action/from/to/fromPx/toPx/
winexp/visits/moveVisits/top) so play.py.mcts_move can call it unchanged, plus
an extra "effSims"/"workers" for logging.

Usage: nwmove_par.py state.json [--sims 64000] [--workers 8] [--c-puct 2.5]
                       [--nroll 1] [--turns N]   (--sims is PER-WORKER)
"""
import argparse
import json
import multiprocessing as mp
import os
import sys

import numpy as np

SOLVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SOLVER_DIR)

from network_wars import State, Node as GNode
import fastnw

# Module globals captured by fork() before the Pool is created — workers read
# these directly so we never re-pickle the board per task.
_G = {}


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


def _worker(seed):
    """One independent search with its own sim-seed. Topology is inherited from
    the parent via fork; we only re-seed the search RNG. Returns (acts, visits, q)
    as plain lists so they pickle back cheaply."""
    fastnw.use_sim(seed)
    acts, visits, q = fastnw.uct_search(
        _G['owner'], _G['strength'], _G['turns'], _G['sims'],
        _G['c_puct'], _G['nroll'], return_q=True)
    return [int(a) for a in acts], [int(v) for v in visits], [float(x) for x in q]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('state')
    ap.add_argument('--sims', type=int, default=64000, help='PER-WORKER sims')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--wset', default='C1', help='back-compat; ignored (C1 baked in)')
    ap.add_argument('--policy', type=int, default=1, help='back-compat; ignored')
    ap.add_argument('--turns', type=int, default=1)
    ap.add_argument('--sim-seed', type=int, default=0x12345678)
    args = ap.parse_args()

    js = json.load(open(args.state))
    px = {n['id']: [n['px'], n['py']] for n in js['nodes']}
    state = build_state(js)

    # Set topology in the PARENT so forked workers inherit the C ADJ globals.
    fastnw.set_topology(state)
    owner, strength = fastnw.board_arrays(state)
    _G.update(owner=owner, strength=strength, turns=args.turns, sims=args.sims,
              c_puct=args.c_puct, nroll=args.nroll)

    # Distinct sim-seed per worker (splitmix64 mixes well, but spread them anyway).
    seeds = [(args.sim_seed + i * 0x9E3779B1) & 0xFFFFFFFFFFFFFFFF
             for i in range(args.workers)]

    # fork: children share the already-loaded .so + topology (fast, no re-import).
    # We have no threads, so fork is safe here despite macOS defaulting to spawn.
    ctx = mp.get_context('fork')
    with ctx.Pool(args.workers) as pool:
        results = pool.map(_worker, seeds)

    # Aggregate by action id: sum visits, visit-weight Q.
    agg_v, agg_qw = {}, {}
    for acts, visits, q in results:
        for a, v, qq in zip(acts, visits, q):
            agg_v[a] = agg_v.get(a, 0) + v
            agg_qw[a] = agg_qw.get(a, 0.0) + v * qq
    if not agg_v:
        print(json.dumps({'action': 'stop', 'winexp': None}))
        return

    actions = list(agg_v.keys())
    tv = sum(agg_v.values())
    best = max(actions, key=lambda a: agg_v[a])
    def q_of(a):
        return agg_qw[a] / agg_v[a] if agg_v[a] else 0.0
    winexp = q_of(best)

    nodes_by_id = {n['id']: n for n in js['nodes']}
    order = sorted(actions, key=lambda a: -agg_v[a])[:14]
    top = []
    for a in order:
        if a == -1:
            top.append({'action': -1, 'from': None, 'to': None, 'label': 'END TURN',
                        'from_owner': None, 'to_owner': None, 'visits': agg_v[a],
                        'frac': agg_v[a] / tv if tv else 0.0, 'q': q_of(a)})
            continue
        f, t = a >> 8, a & 0xFF
        nf, nt = nodes_by_id.get(f), nodes_by_id.get(t)
        lbl = (f"{nf['owner'][0].upper()}{nf['strength']}→{nt['owner'][0].upper()}{nt['strength']}"
               if nf and nt else '?')
        top.append({'action': a, 'from': f, 'to': t, 'label': lbl,
                    'from_owner': nf['owner'] if nf else None,
                    'to_owner': nt['owner'] if nt else None,
                    'visits': agg_v[a], 'frac': agg_v[a] / tv if tv else 0.0, 'q': q_of(a)})

    eff = args.sims * args.workers
    if best == -1:
        print(json.dumps({'action': 'stop', 'winexp': winexp, 'visits': tv,
                          'top': top, 'effSims': eff, 'workers': args.workers}))
        return
    frm, to = best >> 8, best & 0xFF
    print(json.dumps({
        'action': 'attack', 'from': frm, 'to': to,
        'fromPx': px[frm], 'toPx': px[to],
        'winexp': winexp, 'visits': tv, 'moveVisits': agg_v[best], 'top': top,
        'effSims': eff, 'workers': args.workers,
    }))


if __name__ == '__main__':
    main()
