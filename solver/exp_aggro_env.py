#!/usr/bin/env python3
"""A/B: does a MORE AGGRESSIVE environment bot (one that attacks equal-strength /
uphill targets, as observed in live play via bot_behavior_diff) drop offline
self-play winrate from ~97% toward the live ~80%?

Red's SEARCH is unchanged (C engine, models strictly-greedy best_bot_move). Only
the ENVIRONMENT'S bot policy is patched (network_wars.best_bot_move), so this
isolates the effect of red planning against a weaker opponent model than it faces.

  mode=baseline : env bots attack strictly-weaker targets (the shipped model)
  mode=equal    : env bots also attack EQUAL-strength targets
  mode=uphill   : env bots attack ANY enemy neighbor (most aggressive)

Usage: python exp_aggro_env.py --games 200 --sims 2000 --workers 9 --mode equal
"""
import argparse, os, time
from multiprocessing import Pool


def run_chunk(arg):
    seeds, sims, c_puct, mode = arg
    import numpy as np
    import network_wars as nw
    from network_wars import HUMAN, BOTS
    import fastnw

    def aggro_move(state, faction):
        """Like best_bot_move but with `mode`'s threshold (equal: allow ==; uphill: any)."""
        best = None
        for n in state.nodes:
            if n.owner != faction or n.strength <= 1:
                continue
            for nb in state.adj[n.id]:
                t = state.nodes[nb]
                if t.owner == faction:
                    continue
                if mode == 'equal' and t.strength > n.strength:
                    continue   # allow == and <, skip strictly-stronger
                # mode == 'uphill': attack any enemy neighbor
                cand = (n.id, nb, n.strength, t.strength)
                if (best is None
                        or cand[3] < best[3]
                        or (cand[3] == best[3] and cand[2] > best[2])
                        or (cand[3] == best[3] and cand[2] == best[2] and cand[0] < best[0])
                        or (cand[3] == best[3] and cand[2] == best[2] and cand[0] == best[0] and cand[1] < best[1])):
                    best = cand
        return best

    # The bots run in C now, so to make the env MORE aggressive we replay the bot turn
    # in Python with the aggro policy + the SHIPPED (C, power-ratio) battle via the shim.
    def bot_turn(state, faction, move_fn):
        if nw.counts(state)[faction] == 0:
            return
        g = 0
        while g < 1000:
            g += 1
            mv = move_fn(state, faction)
            if mv is None:
                break
            nw.resolve_battle(state, mv[0], mv[1])     # shim: real mb32 stream, C battle
            if nw.check_winner(state) is not None:
                return
        nw.reinforce(state, faction)

    move_fn = nw.best_bot_move if mode == 'baseline' else aggro_move

    wins = 0
    for s in seeds:
        st = nw.make_game(s)
        fastnw.set_topology(st)
        fastnw.use_sim(0x12345678)
        turns = 1
        for _ in range(6000):
            if nw.check_winner(st) is not None or nw.counts(st)[HUMAN] == 0:
                break
            owner, strength = fastnw.board_arrays(st)
            acts, visits = fastnw.uct_search(owner, strength, turns, sims, c_puct)
            action = -1 if len(acts) == 0 else int(acts[int(np.argmax(visits))])
            if action != -1:
                frm, to = action >> 8, action & 0xFF
                if (st.nodes[frm].owner == HUMAN and st.nodes[frm].strength > 1
                        and st.nodes[to].owner != HUMAN and to in st.adj[frm]):
                    nw.resolve_battle(st, frm, to)
                    continue
            # END_TURN (or illegal): red reinforce + all bot turns
            nw.reinforce(st, HUMAN)
            if nw.check_winner(st) is None:
                for b in BOTS:
                    bot_turn(st, b, move_fn)
                    if nw.check_winner(st) is not None:
                        break
            turns += 1
            if turns > nw.MAX_TURNS:
                break
        wins += 1 if nw.check_winner(st) == HUMAN else 0
    return wins, len(seeds)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=200)
    ap.add_argument('--sims', type=int, default=2000)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--workers', type=int, default=9)
    ap.add_argument('--mode', default='baseline', choices=['baseline', 'equal', 'uphill'])
    a = ap.parse_args()

    seeds = list(range(a.seed_base, a.seed_base + a.games))
    chunks = [seeds[i::a.workers] for i in range(a.workers)]
    tasks = [(c, a.sims, a.c_puct, a.mode) for c in chunks if c]
    print(f'mode={a.mode}  games={a.games} sims={a.sims} c_puct={a.c_puct}', flush=True)
    t0 = time.time()
    with Pool(a.workers) as pool:
        res = pool.map(run_chunk, tasks)
    wins = sum(w for w, _ in res); tot = sum(n for _, n in res)
    dt = time.time() - t0
    print(f'  winrate : {wins/tot*100:.1f}%  ({wins}/{tot})   [{dt:.0f}s]', flush=True)


if __name__ == '__main__':
    main()
