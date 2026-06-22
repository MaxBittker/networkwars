"""Fast MCTS driver: plan with the C UCT search, play the real seeded game.

Each RED decision converts the live Python state to int arrays and calls the C
open-loop UCT search (sim dice from a private seed-free rng). The chosen action is
applied to the REAL Python state with the REAL seeded rng, so the game outcome is
the true one — no seed exploitation (search never sees the game seed).

Build the engine first:
    cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so
Best config: ranked C1 weights, c_puct=2.5, sims=1600-3200.
    uv run python fmcts.py --games 120 --sims 3200 --wset C1 --c-puct 2.5
"""
import argparse
import time

import numpy as np

import network_wars as nw
from network_wars import (HUMAN, BOTS, make_game, check_winner, counts,
                          reinforce, run_bot_turn, resolve_battle)
import fastnw

# tuned ranked weight sets (capture,weakTarget,margin,source,redAdj,merge,
# largestTouch,enemyCount,eliminate,exposure,lowChancePenalty,strongTargetPenalty,threshold)
WSETS = {
    "C4":      [41.626, 16.58, 3.155, 9.863, 34.636, 75.442, 65.481, 13.635, 195.996, 41.79, 126.886, 4.498, 221.259],
    "C1":      [44.687, 69.885, 9.789, 1.754, 59.153, 114.472, 77.164, 9.322, 0, 60.487, 140.411, 0, 220.775],
    "LEGACY":  [97.712, 39.979, 9.575, 1.539, 50.51, 84.483, 33.024, 8.746, 104.618, 48.101, 67.034, 0, 184.966],
    "DELAYED": [28.795, 3.674, 10.874, 9.522, 68.557, 185, 11.775, 25.161, 92.279, 103.136, 216.851, 4.551, 235],
}

HEUR = [0, 0.02]   # [enabled, beta] — set from CLI in main()
ROLL_TEMP = [0.0]  # rollout softmax temperature (0 = argmax)
ENSEMBLE = [None]  # list of wset names to rotate, or None
SAFETY = [45.0, 28.0]  # [threat-reduction weight, capture weight] for policy=2


def play_game(seed, sims, c_puct=2.5, nroll=1, sim_seed=0x12345678,
              max_actions=6000, priors_fn=None, wset="C1", policy=1):
    state = make_game(seed)
    fastnw.set_topology(state)
    fastnw.set_red_rollout_policy(policy)
    if wset in WSETS:
        fastnw.set_ranked_weights(WSETS[wset])
    fastnw.set_heur_priors(HEUR[0], HEUR[1])
    fastnw.set_roll_temp(ROLL_TEMP[0])
    fastnw.set_ensemble([WSETS[n] for n in ENSEMBLE[0]] if ENSEMBLE[0] else [])
    fastnw.set_safety_params(SAFETY[0], SAFETY[1])
    fastnw.use_sim(sim_seed)
    turns = 1
    for _ in range(max_actions):
        w = check_winner(state)
        if w is not None or counts(state)[HUMAN] == 0:
            break
        owner, strength = fastnw.board_arrays(state)
        # quick legal check: any RED attack available?
        root_pri = priors_fn(state, owner, strength) if priors_fn else None
        acts, visits = fastnw.uct_search(owner, strength, turns, sims, c_puct,
                                         nroll, root_pri)
        if len(acts) == 0:
            action = -1
        else:
            action = int(acts[int(np.argmax(visits))])
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
    return check_winner(state) == HUMAN, turns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=120)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--sims', type=int, default=1600)
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--wset', default='C1')   # C1 ranked rollout, c_puct 2.5 = best
    ap.add_argument('--policy', type=int, default=1)
    ap.add_argument('--heur', type=int, default=0, help='1=heuristic softmax priors')
    ap.add_argument('--beta', type=float, default=0.02)
    ap.add_argument('--temp', type=float, default=0.0, help='rollout softmax temperature')
    ap.add_argument('--ensemble', default='', help='comma list of wsets to rotate, e.g. C1,LEGACY,C4')
    ap.add_argument('--safety-sw', type=float, default=45.0)
    ap.add_argument('--safety-rg', type=float, default=28.0)
    flags = ap.parse_args()
    SAFETY[0] = flags.safety_sw
    SAFETY[1] = flags.safety_rg
    HEUR[0] = flags.heur
    HEUR[1] = flags.beta
    ROLL_TEMP[0] = flags.temp
    ENSEMBLE[0] = flags.ensemble.split(',') if flags.ensemble else None

    t0 = time.time()
    wins, twin = 0, []
    for s in range(flags.seed_base, flags.seed_base + flags.games):
        won, turns = play_game(s, flags.sims, flags.c_puct, flags.nroll,
                               wset=flags.wset, policy=flags.policy)
        if won:
            wins += 1
            twin.append(turns)
    dt = time.time() - t0
    print(f'fast-UCT sims={flags.sims} c={flags.c_puct} nroll={flags.nroll} '
          f'wset={flags.wset} temp={flags.temp} ens={flags.ensemble or "-"} — '
          f'{flags.games} games seeds {flags.seed_base}..{flags.seed_base+flags.games-1}')
    print(f'  winrate : {wins/flags.games*100:.1f}%  ({wins}/{flags.games})')
    print(f'  time    : {dt:.1f}s, {dt/flags.games*1000:.0f} ms/game')


if __name__ == '__main__':
    main()
