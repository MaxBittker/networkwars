#!/usr/bin/env python3
"""Detector-feasibility probe: for each lost opening, measure whether the search's
ROOT decision (top move + its backed-up win-prob Q) is STILL MOVING as sims grow,
or has converged. This is the signal an adaptive 'deep-think' trigger would key on.

If g67 (deep search recovers +20pts) shows large win-prob drift / move churn while
g81 (search-proof) is flat-and-stable, a cheap convergence detector could spend
big sims only where it pays. If they look the same, the detector can't separate
'under-searched' from 'converged-but-losing' and adaptive compute won't help
selectively.

Runs each opening at several budgets, repeated over a few search-RNG seeds (the
rollout stream is seeded) to separate signal from search noise.
"""
import argparse, json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import nwmove_fast as NWM
import fastnw


def load(runfile, want):
    out = {}
    for line in open(runfile):
        try: r = json.loads(line)
        except: continue
        if r.get('type') == 'meta': continue
        if r.get('game_index') not in want: continue
        bb = r['trajectory'][0]['board_before']
        out[r['game_index']] = {'nodes': [{'id': n['id'], 'col': n['c'], 'row': n['r'],
                                           'owner': n['o'], 'strength': n['s']} for n in bb]}
    return out


def probe(board, budgets, seeds, c_puct):
    """Return per-budget: mean top Q, std of top Q across seeds, top-move-set."""
    st = NWM.build_state(board)
    fastnw.set_topology(st)
    owner, strength = fastnw.board_arrays(st)
    res = {}
    for b in budgets:
        qs, moves = [], []
        for sd in seeds:
            fastnw.use_sim(0x12345678 ^ sd)
            acts, vis, q = fastnw.uct_search(owner, strength, 1, b, c_puct, 1, return_q=True)
            i = int(np.argmax(vis))
            qs.append(float(q[i])); moves.append(int(acts[i]))
        res[b] = {'q_mean': float(np.mean(qs)), 'q_std': float(np.std(qs)),
                  'moves': moves, 'n_distinct_moves': len(set(moves))}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('runfile')
    ap.add_argument('--games', default='15,42,45,67,81,89')
    ap.add_argument('--budgets', default='8000,16000,64000,256000')
    ap.add_argument('--seeds', type=int, default=6)
    ap.add_argument('--c-puct', type=float, default=2.5)
    a = ap.parse_args()
    want = [int(x) for x in a.games.split(',')]
    budgets = [int(x) for x in a.budgets.split(',')]
    seeds = list(range(1, a.seeds + 1))
    boards = load(a.runfile, set(want))

    hardset = {67, 81, 89}
    print(f"opening-position convergence probe ({a.seeds} search seeds/budget)\n")
    print(f"{'game':>5} {'type':>5} | " + " | ".join(f"Q@{b//1000}k(±sd, #mv)" for b in budgets)
          + " | drift 8k->256k")
    for g in want:
        if g not in boards: continue
        r = probe(boards[g], budgets, seeds, a.c_puct)
        cells = []
        for b in budgets:
            x = r[b]
            cells.append(f"{x['q_mean']:.2f}(±{x['q_std']:.02f},{x['n_distinct_moves']})")
        drift = r[budgets[-1]]['q_mean'] - r[budgets[0]]['q_mean']
        typ = 'HARD' if g in hardset else 'easy'
        print(f"{('g'+str(g)):>5} {typ:>5} | " + " | ".join(cells) + f" | {drift:+.2f}")
    print("\nQ = backed-up RED win-prob of the argmax-visit root move.")
    print("#mv = distinct top moves across the search seeds (1 = stable choice).")


if __name__ == '__main__':
    main()
