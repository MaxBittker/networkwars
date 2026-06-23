#!/usr/bin/env python3
"""Decisive test: is the offline-97% vs live-80% gap caused by the BOARD/DEAL
distribution (real opening boards harder for red than sim-generated ones)?

Extract the REAL round-0 opening boards from the live series logs, then run pure
offline self-play from each (identical engine: C-UCT search + baseline strictly-
greedy bots + calibrated power-ratio battle — the SAME setup that scores ~97.5%
on sim-generated boards via exp_aggro_env baseline). Several dice seeds per board.

If real-opening-board winrate ~= 97%, the gap is IN PLAY (OCR/execution/battle/bot
residual). If it falls toward ~80%, the gap is the board distribution and the sim
board generator does not match the real iOS deal's spatial structure.

Usage: python open_board_eval.py [--seeds 5] [--sims 2000] [--workers 9]
"""
import argparse, json, os, sys, time
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import nwmove_fast as NWM


def load_open_boards(files, want_counts=True):
    boards = []
    for f in files:
        if not os.path.exists(f):
            continue
        for line in open(f):
            try: r = json.loads(line)
            except: continue
            if r.get('type') != 'game': continue
            traj = r.get('trajectory', [])
            if not traj: continue
            t0 = traj[0]
            if t0.get('round') not in (0, None): continue
            bb = t0.get('board_before')
            if not bb or len(bb) != 30: continue
            # need clean strengths + 6 nodes/faction
            if any(n.get('s') is None for n in bb): continue
            from collections import Counter
            cc = Counter(n['o'] for n in bb)
            if want_counts and (len(cc) != 5 or any(v != 6 for v in cc.values())):
                continue
            boards.append({'nodes': [{'id': n['id'], 'col': n['c'], 'row': n['r'],
                                      'owner': n['o'], 'strength': n['s']} for n in bb]})
    return boards


def run_chunk(arg):
    boards, seeds, sims, c_puct = arg
    import network_wars as nw
    from network_wars import HUMAN, BOTS, check_winner, counts, reinforce, run_bot_turn, resolve_battle
    import fastnw
    import numpy as np

    wins = tot = 0
    for board in boards:
        for sd in seeds:
            # fresh state from the real board (baseline C-UCT, baked C1 rollout)
            st = NWM.build_state(board)
            st.mb = sd & 0xFFFFFFFF                       # real-game (battle) stream seed
            st.policy_rng = nw.make_rng((sd ^ 0x9E3779B9) & 0xFFFFFFFF)
            fastnw.set_topology(st)
            fastnw.use_sim(0x12345678 ^ sd)
            turns = 1
            for _ in range(6000):
                if check_winner(st) is not None or counts(st)[HUMAN] == 0:
                    break
                # resolve_battle/run_bot_turn switch the active C RNG to mb32.
                # The live move subprocess resets to private sim dice for every
                # search; do the same here to avoid future-dice leakage.
                fastnw.use_sim(0x12345678 ^ sd)
                owner, strength = fastnw.board_arrays(st)
                acts, visits = fastnw.uct_search(owner, strength, turns, sims, c_puct, 1)
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
            wins += 1 if check_winner(st) == HUMAN else 0
            tot += 1
    return wins, tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', type=int, default=5, help='dice seeds per real board')
    ap.add_argument('--sims', type=int, default=2000)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--workers', type=int, default=9)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--sim-boards', type=int, default=0,
                    help='instead of real boards, generate N make_game boards (control)')
    ap.add_argument('files', nargs='*', default=[
        'runs/series_20260622_prsearch.jsonl', 'runs/series_20260621_battle.jsonl',
        'runs/series_16k.jsonl', 'runs/series_20260621_200g.jsonl'])
    a = ap.parse_args()

    if a.sim_boards:
        import network_wars as nw
        boards = []
        for seed in range(1, a.sim_boards + 1):
            st_ = nw.make_game(seed)
            boards.append({'nodes': [{'id': nd.id, 'col': nd.x, 'row': nd.y,
                                      'owner': nd.owner, 'strength': nd.strength}
                                     for nd in st_.nodes]})
        print(f"CONTROL: {len(boards)} make_game (sim) opening boards", flush=True)
    else:
        boards = load_open_boards(a.files)
    if a.limit:
        boards = boards[:a.limit]
    seeds = list(range(1, a.seeds + 1))
    print(f"{len(boards)} real opening boards x {a.seeds} dice seeds = "
          f"{len(boards)*a.seeds} games, sims={a.sims}", flush=True)
    chunks = [boards[i::a.workers] for i in range(a.workers)]
    tasks = [(c, seeds, a.sims, a.c_puct) for c in chunks if c]
    t0 = time.time()
    with Pool(a.workers) as pool:
        res = pool.map(run_chunk, tasks)
    wins = sum(w for w, _ in res); tot = sum(t for _, t in res)
    print(f"  winrate on REAL opening boards: {wins/tot*100:.1f}%  ({wins}/{tot})  "
          f"[{time.time()-t0:.0f}s]", flush=True)
    print("  (compare: sim-generated boards ~97.5% same config)")


if __name__ == '__main__':
    main()
