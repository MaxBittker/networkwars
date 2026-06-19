"""AlphaZero self-play data generation for Network Wars.

Plays games with MCTS(current net) and records, at every RED decision:
  * the observation,
  * the MCTS visit distribution over the 289 actions (the improved policy
    target), and
  * the eventual game outcome (the value target).

Root Dirichlet noise + visit-count temperature give exploration. Seeds are kept
disjoint from the eval range (1..N) and the SL-expert range.

  uv run python selfplay.py sl_cnn.pt --games 1500 --sims 100 --seed-base 300000 --out sp0
"""

import argparse
import importlib

import numpy as np
import torch

import network_wars as nw
from network_wars import (
    HUMAN, N_ACTIONS, END_TURN, MAX_TURNS, make_game, check_winner, counts,
)
from mcts import (
    Evaluator, mcts_search, coord_map, legal_action_indices, apply_action,
)


def selfplay_game(ev, seed, sims, c_puct, rng, temp_moves=10, dirichlet=0.3):
    state = make_game(seed)
    c2id = coord_map(state)
    turns = 1
    records = []          # (obs_f16, pi_f32)
    move_no = 0
    for _ in range(4000):
        if check_winner(state) is not None or counts(state)[HUMAN] == 0:
            break
        legal = legal_action_indices(state, c2id)
        if len(legal) == 1:
            action = END_TURN
        else:
            root = mcts_search(state, turns, ev, c2id, sims, c_puct,
                               dirichlet=dirichlet, rng_noise=rng)
            visits = np.zeros(N_ACTIONS, dtype=np.float32)
            for a in legal:
                visits[a] = root.N.get(a, 0)
            if visits.sum() == 0:
                visits[END_TURN] = 1.0
            pi = visits / visits.sum()
            ev._env.state = state; ev._env.turns = turns
            records.append((ev._env._obs().astype(np.float16), pi))
            if move_no < temp_moves:
                action = int(rng.choice(N_ACTIONS, p=pi))   # temp=1 sampling
            else:
                action = int(visits.argmax())
        move_no += 1
        turns, terminated, winner = apply_action(state, turns, action, c2id)
        if terminated or turns > MAX_TURNS:
            break
    won = 1.0 if check_winner(state) == HUMAN else 0.0
    return records, won


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('checkpoint')
    ap.add_argument('--policy', default='policy_cnn')
    ap.add_argument('--games', type=int, default=1500)
    ap.add_argument('--seed-base', type=int, default=300000)
    ap.add_argument('--sims', type=int, default=100)
    ap.add_argument('--c-puct', type=float, default=1.5)
    ap.add_argument('--dirichlet', type=float, default=0.3)
    ap.add_argument('--out', default='sp0')
    flags = ap.parse_args()

    from evaluate import _EnvShim
    net = importlib.import_module(flags.policy).Policy(_EnvShim(nw.OBS_DIM))
    net.load_state_dict(torch.load(flags.checkpoint, map_location='cpu'))
    net.eval()
    ev = Evaluator(net)

    rng = np.random.default_rng(12345)
    obs_l, pi_l, z_l = [], [], []
    wins = 0
    import time
    t0 = time.time()
    for g in range(flags.games):
        recs, won = selfplay_game(ev, flags.seed_base + g, flags.sims, flags.c_puct, rng,
                                  dirichlet=flags.dirichlet)
        wins += won
        for o, pi in recs:
            obs_l.append(o); pi_l.append(pi); z_l.append(won)
        if (g + 1) % 100 == 0:
            print(f'  {g+1}/{flags.games} games, {len(obs_l)} states, '
                  f'winrate {wins/(g+1):.3f}, {(time.time()-t0)/(g+1):.2f}s/game', flush=True)

    np.save(f'{flags.out}_obs.npy', np.stack(obs_l).astype(np.float16))
    np.save(f'{flags.out}_pi.npy', np.stack(pi_l).astype(np.float16))
    np.save(f'{flags.out}_z.npy', np.array(z_l, dtype=np.float32))
    print(f'saved {flags.out}_*.npy  {len(obs_l)} states, selfplay winrate {wins/flags.games:.3f}')


if __name__ == '__main__':
    main()
