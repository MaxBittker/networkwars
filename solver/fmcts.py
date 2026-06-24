"""Fast MCTS driver: plan with the C UCT search, play the real seeded game.

Each RED decision converts the live Python state to int arrays and calls the C
open-loop UCT search (sim dice from a private seed-free rng). The chosen action is
applied to the REAL Python state with the REAL seeded rng, so the game outcome is
the true one — no seed exploitation (search never sees the game seed).

Build the engine first:
    cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so
Best config (baked into the engine): ranked C1 rollout, c_puct=2.5, sims=1600-3200.
    uv run python fmcts.py --games 120 --sims 3200 --c-puct 2.5
"""
import argparse
import time

import numpy as np

import network_wars as nw
from network_wars import (HUMAN, BOTS, make_game, check_winner, counts,
                          reinforce, run_bot_turn, resolve_battle)
import fastnw


def play_game(seed, sims, c_puct=2.5, nroll=1, sim_seed=0x12345678,
              max_actions=6000, max_sims=None):
    state = make_game(seed)
    fastnw.set_topology(state)
    fastnw.use_sim(sim_seed)
    turns = 1
    total_sims = 0
    n_moves = 0
    for _ in range(max_actions):
        w = check_winner(state)
        if w is not None or counts(state)[HUMAN] == 0:
            break
        # Real game mutations switch the C engine to the real mb32 dice stream.
        # Reset before every search so offline eval matches the live nwmove_fast
        # subprocess path and never plans with the real game's future dice.
        fastnw.use_sim(sim_seed)
        owner, strength = fastnw.board_arrays(state)
        acts, visits = fastnw.uct_search(owner, strength, turns, sims, c_puct,
                                         nroll, max_sims=max_sims)
        total_sims += int(visits.sum())   # sum of root visits == sims this search
        n_moves += 1
        action = -1 if len(acts) == 0 else int(acts[int(np.argmax(visits))])
        # apply to REAL state with REAL rng
        if action == -1:
            reinforce(state, HUMAN)
            if not check_winner(state):
                for bot in BOTS:
                    run_bot_turn(state, bot)
                    if check_winner(state):
                        break
            turns += 1
        else:
            frm, to = action >> 8, action & 0xFF
            if state.nodes[frm].owner == HUMAN and state.nodes[frm].strength > 1 \
                    and state.nodes[to].owner != HUMAN and to in state.adj[frm]:
                resolve_battle(state, frm, to)
            else:
                # safety: treat as end-turn if somehow illegal
                reinforce(state, HUMAN)
                if not check_winner(state):
                    for bot in BOTS:
                        run_bot_turn(state, bot)
                        if check_winner(state):
                            break
                turns += 1
        if turns > nw.MAX_TURNS:
            break
    return check_winner(state) == HUMAN, turns, total_sims, n_moves


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=120)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--sims', type=int, default=1600)
    ap.add_argument('--max-sims', type=int, default=None,
                    help='adaptive ceiling (default = --sims, i.e. fixed budget)')
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--value-stop', nargs=4, type=float, metavar=('LO','HI','GAP','MINVIS'),
                    help='enable value-based early stop, e.g. --value-stop 0.03 0.97 0.15 512')
    flags = ap.parse_args()

    if flags.value_stop:
        lo, hi, gap, minvis = flags.value_stop
        fastnw.set_value_stop(lo, hi, gap, int(minvis))

    t0 = time.time()
    wins = 0
    tot_sims = 0
    tot_moves = 0
    for s in range(flags.seed_base, flags.seed_base + flags.games):
        won, _, gs, gm = play_game(s, flags.sims, flags.c_puct, flags.nroll,
                                   max_sims=flags.max_sims)
        tot_sims += gs
        tot_moves += gm
        if won:
            wins += 1
    dt = time.time() - t0
    vs = f' value-stop={flags.value_stop}' if flags.value_stop else ''
    print(f'fast-UCT sims={flags.sims} max_sims={flags.max_sims} c={flags.c_puct} '
          f'nroll={flags.nroll}{vs} — '
          f'{flags.games} games seeds {flags.seed_base}..{flags.seed_base+flags.games-1}')
    print(f'  winrate : {wins/flags.games*100:.1f}%  ({wins}/{flags.games})')
    print(f'  avg sims/move : {tot_sims/max(1,tot_moves):.0f}  ({tot_moves} moves)')
    print(f'  time    : {dt:.1f}s, {dt/flags.games*1000:.0f} ms/game')


if __name__ == '__main__':
    main()
