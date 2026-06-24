#!/usr/bin/env python3
"""Opponent-erosion test: does our sim's opponent phase (best_bot_move + our
battle model) erode RED as hard as the REAL iOS opponents do?

For each round transition in the live log: take the board at the END of RED's
attacks, replay the opponent phase in the sim (end_turn = RED reinforce + 4 bot
turns) K times, and compare mean sim RED survival to the live next-turn board.

If sim leaves RED systematically STRONGER than reality -> real opponents are
tougher than our model -> offline over-predicts. That's the systematic gap.
"""
import json, os, sys
import numpy as np
SOLVER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SOLVER)
import fastnw
FIDX = fastnw.FIDX
RED = FIDX['red']
K = 300

def board_to_arrays(board):
    """board: list of {id,r,c,o,s} -> (owner[], strength[], adj_list, ids_ok)."""
    n = len(board)
    bid = {nd['id']: nd for nd in board}
    ids = sorted(bid)
    if ids != list(range(n)):       # non-contiguous ids -> skip (parser dropout)
        return None
    owner = np.zeros(n, dtype=np.int32)
    strength = np.zeros(n, dtype=np.int32)
    rc = {}
    for nd in board:
        i = nd['id']
        owner[i] = FIDX[nd['o']]
        strength[i] = nd['s']
        rc[i] = (nd['c'], nd['r'])      # x=col, y=row
    adj = [[] for _ in range(n)]
    for i in range(n):
        xi, yi = rc[i]
        for j in range(i+1, n):
            xj, yj = rc[j]
            if abs(xi-xj) <= 1 and abs(yi-yj) <= 1:
                adj[i].append(j); adj[j].append(i)
    return owner, strength, adj

def post_red_board(rd):
    """Board after RED's attacks this round (before reinforce)."""
    applied = [m for m in rd.get('moves', []) if m.get('board_after')]
    return applied[-1]['board_after'] if applied else rd.get('board_before')

def red_stats(owner, strength):
    m = owner == RED
    return int(m.sum()), int(strength[m].sum())

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'runs/series_live_64k.jsonl'
    games = [json.loads(l) for l in open(path) if '"type": "meta"' not in l]
    by_round = {}   # round -> list of (sim_nodes-live_nodes, sim_units-live_units)
    transitions = 0
    for g in games:
        if g.get('game_index', 0) == 0:     # g0 = inherited mid-game board, skip
            continue
        traj = g.get('trajectory', [])
        for N in range(len(traj) - 1):
            pre = post_red_board(traj[N])
            nxt = traj[N+1].get('board_before')
            if not pre or not nxt:
                continue
            a = board_to_arrays(pre)
            if a is None:
                continue
            owner0, strength0, adj = a
            # live next-turn RED
            an = board_to_arrays(nxt)
            if an is None or len(an[0]) != len(owner0):
                continue
            live_nodes, live_units = red_stats(an[0], an[1])
            if red_stats(owner0, strength0)[0] == 0:
                continue
            fastnw.set_topology_csr(len(owner0), adj)
            sim_nodes = np.empty(K); sim_units = np.empty(K)
            for k in range(K):
                fastnw.use_sim((N * 7919 + k * 104729 + g['game_index'] * 13) & 0x7fffffff)
                o = owner0.copy(); s = strength0.copy()
                fastnw.end_turn(o, s)       # RED reinforce + 4 bot turns (sim model)
                n_, u_ = red_stats(o, s)
                sim_nodes[k] = n_; sim_units[k] = u_
            rnd = traj[N]['round']
            by_round.setdefault(rnd, []).append(
                (sim_nodes.mean() - live_nodes, sim_units.mean() - live_units,
                 sim_nodes.mean(), live_nodes))
            transitions += 1
    print(f'transitions analyzed: {transitions}  (K={K} MC opponent-phase rollouts each)')
    print(f'{"round":>5} {"n":>4} {"sim_redNodes":>12} {"live_redNodes":>13} {"Δnodes":>7} {"Δunits":>7}')
    alld = []
    for rnd in sorted(by_round):
        rows = by_round[rnd]
        dn = np.mean([r[0] for r in rows]); du = np.mean([r[1] for r in rows])
        sn = np.mean([r[2] for r in rows]); ln = np.mean([r[3] for r in rows])
        alld += rows
        print(f'{rnd:>5} {len(rows):>4} {sn:>12.2f} {ln:>13.2f} {dn:>+7.2f} {du:>+7.2f}')
    DN = np.mean([r[0] for r in alld]); DU = np.mean([r[1] for r in alld])
    print(f'\nOVERALL Δnodes (sim - live) = {DN:+.3f}   Δunits = {DU:+.3f}')
    print('positive Δ => sim leaves RED STRONGER than reality => real opponents tougher than our model')

if __name__ == '__main__':
    main()
