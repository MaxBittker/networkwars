"""Per-seed outcome tracker: is the ~78% ceiling irreducible? Each seed is a
deterministic game given red's policy (real dice are seeded), so a "loss" is a
specific (deal, dice) seed. If losing seeds don't flip to wins under far more
compute, the ceiling is provably optimal play, not a search deficiency.

  python per_seed.py --seeds 1-200 --sims 1600 --out /tmp/ps_1600.txt
  python per_seed.py --seedfile /tmp/losers.txt --sims 32000 --out /tmp/ps_32k.txt
"""
import argparse, sys
import numpy as np
import network_wars as nw
from network_wars import HUMAN, BOTS, make_game, check_winner, counts, reinforce, run_bot_turn, resolve_battle
import fastnw
from fmcts import WSETS


def play(seed, sims, c_puct=2.5, nroll=1, wset="C1", policy=1, sim_seed=0x12345678):
    state = make_game(seed)
    fastnw.set_topology(state)
    fastnw.set_red_rollout_policy(policy)
    fastnw.set_ranked_weights(WSETS[wset])
    fastnw.set_heur_priors(0, 0.02)
    fastnw.set_roll_temp(0.0)
    fastnw.set_ensemble([])
    fastnw.set_safety_params(45.0, 28.0)
    fastnw.set_leaf_trunc(-1)
    fastnw.use_sim(sim_seed)
    turns = 1
    for _ in range(6000):
        if check_winner(state) is not None or counts(state)[HUMAN] == 0:
            break
        owner, strength = fastnw.board_arrays(state)
        acts, visits = fastnw.uct_search(owner, strength, turns, sims, c_puct, nroll, None)
        action = int(acts[int(np.argmax(visits))]) if len(acts) else -1
        if action == -1:
            reinforce(state, HUMAN)
            if not check_winner(state):
                for b in BOTS:
                    run_bot_turn(state, b)
                    if check_winner(state):
                        break
            turns += 1
        else:
            frm, to = action >> 8, action & 0xFF
            if state.nodes[frm].owner == HUMAN and state.nodes[frm].strength > 1 \
                    and state.nodes[to].owner != HUMAN and to in state.adj[frm]:
                resolve_battle(state, frm, to)
            else:
                reinforce(state, HUMAN)
                if not check_winner(state):
                    for b in BOTS:
                        run_bot_turn(state, b)
                        if check_winner(state):
                            break
                turns += 1
        if turns > nw.MAX_TURNS:
            break
    return 1 if check_winner(state) == HUMAN else 0


def parse_seeds(s):
    if '-' in s:
        a, b = s.split('-'); return list(range(int(a), int(b) + 1))
    return [int(x) for x in s.split(',')]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', default=None)
    ap.add_argument('--seedfile', default=None)
    ap.add_argument('--sims', type=int, default=1600)
    ap.add_argument('--policy', type=int, default=1)
    ap.add_argument('--sim-seed', type=lambda x: int(x, 0), default=0x12345678)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    if a.seedfile:
        seeds = [int(x) for x in open(a.seedfile).read().split()]
    else:
        seeds = parse_seeds(a.seeds)
    fh = open(a.out, 'w', buffering=1) if a.out else None   # line-buffered: survives kills
    wins = 0
    for s in seeds:
        w = play(s, a.sims, policy=a.policy, sim_seed=a.sim_seed)
        wins += w
        line = f"{s} {w}"
        if fh:
            fh.write(line + '\n')
        else:
            print(line, flush=True)
    msg = f"# {wins}/{len(seeds)} = {wins/len(seeds)*100:.1f}% sims={a.sims} policy={a.policy}"
    if fh:
        fh.write(msg + '\n'); fh.close()
    print(msg, flush=True)


if __name__ == '__main__':
    main()
