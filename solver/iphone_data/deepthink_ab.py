#!/usr/bin/env python3
"""A/B the new adaptive 'deep-think' compute vs a fixed budget, replaying the
live-lost openings. Deep-think = uct_search(floor, ceiling=BIG) + relative-margin
stop (set_deepthink): a position whose best move dominates stops at the floor
(cheap); a contested move runs toward the ceiling (deep search). Reports both
WIN% and MEAN SIMS/MOVE so we see it recovers the under-searched positions (g67)
without spending the ceiling everywhere.

Usage:
  python deepthink_ab.py runs/series_100game_*.jsonl --games 15,42,45,67,81,89 \
      --runs 20 --floor 16000 --ceiling 256000 --ratio 3.0
"""
import argparse, json, os, sys, time
from multiprocessing import Pool
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import nwmove_fast as NWM


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


def play_one(board, seed, floor, ceiling, ratio, c_puct, behind=2.0, dt_minvis=3000):
    """One self-play game from `board`. Returns (won, total_sims, n_searches)."""
    import network_wars as nw
    from network_wars import HUMAN, BOTS, check_winner, counts, reinforce, run_bot_turn, resolve_battle
    import fastnw
    st = NWM.build_state(board)
    st.mb = seed & 0xFFFFFFFF
    st.policy_rng = nw.make_rng((seed ^ 0x9E3779B9) & 0xFFFFFFFF)
    fastnw.set_topology(st)
    # configure deep-think for THIS process (ratio<=0 => disabled => fixed budget)
    if ratio and ratio > 0:
        fastnw.set_deepthink(ratio, dt_minvis, behind)   # contested AND behind -> grind
    else:
        fastnw.set_deepthink(0.0, 1 << 30, 2.0)          # OFF -> fixed `floor` budget
    total_sims = 0; n_searches = 0
    turns = 1
    for _ in range(6000):
        if check_winner(st) is not None or counts(st)[HUMAN] == 0:
            break
        fastnw.use_sim(0x12345678 ^ seed)
        owner, strength = fastnw.board_arrays(st)
        acts, visits = fastnw.uct_search(owner, strength, turns, floor, c_puct, 1,
                                         max_sims=ceiling)
        total_sims += fastnw.sims_done(); n_searches += 1
        action = -1 if len(acts) == 0 else int(acts[int(np.argmax(visits))])
        if action == -1:
            reinforce(st, HUMAN)
            if check_winner(st) is None:
                for b in BOTS:
                    run_bot_turn(st, b)
                    if check_winner(st): break
            turns += 1
        else:
            frm, to = action >> 8, action & 0xFF
            if (st.nodes[frm].owner == HUMAN and st.nodes[frm].strength > 1
                    and st.nodes[to].owner != HUMAN and to in st.adj[frm]):
                resolve_battle(st, frm, to)
            else:
                reinforce(st, HUMAN)
                if check_winner(st) is None:
                    for b in BOTS:
                        run_bot_turn(st, b)
                        if check_winner(st): break
                turns += 1
        if turns > nw.MAX_TURNS:
            break
    return (1 if check_winner(st) == HUMAN else 0, total_sims, n_searches)


def _chunk(arg):
    board, seeds, floor, ceiling, ratio, c_puct, behind = arg
    w = ts = ns = 0
    for sd in seeds:
        won, t, n = play_one(board, sd, floor, ceiling, ratio, c_puct, behind)
        w += won; ts += t; ns += n
    return w, len(seeds), ts, ns


def eval_mode(board, seeds, floor, ceiling, ratio, c_puct, workers, behind=2.0):
    sd_chunks = [seeds[i::workers] for i in range(workers)]
    tasks = [(board, sc, floor, ceiling, ratio, c_puct, behind) for sc in sd_chunks if sc]
    with Pool(len(tasks)) as pool:
        res = pool.map(_chunk, tasks)
    w = sum(x[0] for x in res); n = sum(x[1] for x in res)
    ts = sum(x[2] for x in res); ns = sum(x[3] for x in res)
    return w, n, ts / max(ns, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('runfile')
    ap.add_argument('--games', default='15,42,45,67,81,89')
    ap.add_argument('--runs', type=int, default=20)
    ap.add_argument('--floor', type=int, default=16000)
    ap.add_argument('--ceiling', type=int, default=256000)
    ap.add_argument('--ratio', type=float, default=3.0)
    ap.add_argument('--behind', type=float, default=2.0,
                    help='grind only when leader win-prob < this (2.0 = behind-gate off)')
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--workers', type=int, default=12)
    a = ap.parse_args()
    want = [int(x) for x in a.games.split(',')]
    boards = load(a.runfile, set(want))
    seeds = list(range(1, a.runs + 1))

    print(f"A/B: fixed {a.floor} sims  vs  deep-think [floor {a.floor}, ceiling "
          f"{a.ceiling}, ratio {a.ratio}]   ({a.runs} runs/board)\n", flush=True)
    print(f"{'game':>5} | {'FIXED win%':>10} {'sims/mv':>8} | {'DEEP win%':>10} "
          f"{'sims/mv':>8} {'Δwin':>6}", flush=True)
    tw_f = tn_f = tw_d = tn_d = 0
    t0 = time.time()
    for g in want:
        if g not in boards: continue
        b = boards[g]
        wf, nf, sf = eval_mode(b, seeds, a.floor, a.floor, 0.0, a.c_puct, a.workers)   # fixed
        wd, nd, sd = eval_mode(b, seeds, a.floor, a.ceiling, a.ratio, a.c_puct, a.workers, a.behind)  # deep
        tw_f += wf; tn_f += nf; tw_d += wd; tn_d += nd
        print(f"{('g'+str(g)):>5} | {100*wf/nf:9.0f}% {sf:8.0f} | "
              f"{100*wd/nd:9.0f}% {sd:8.0f} {100*wd/nd-100*wf/nf:+5.0f}", flush=True)
    print(f"\n  TOTAL fixed:     {tw_f}/{tn_f} = {100*tw_f/tn_f:.1f}%")
    print(f"  TOTAL deep-think:{tw_d}/{tn_d} = {100*tw_d/tn_d:.1f}%   [{time.time()-t0:.0f}s]")


if __name__ == '__main__':
    main()
