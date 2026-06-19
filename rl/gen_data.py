"""Generate (obs, win) training data for the calibrated value net.

Plays games with the v5 policy (sampled, for state diversity) and labels every
RED-decision observation with the eventual game outcome (1=RED win, 0=loss).
Uses a seed range DISJOINT from the MCTS eval seeds (1..N) to avoid leakage.

  uv run python gen_data.py policy_cnn_v5.pt --games 3000 --seed-base 100000
"""

import argparse
import importlib

import numpy as np
import torch

import network_wars as nw
from network_wars import N_ACTIONS


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('checkpoint', nargs='?', default='policy_cnn_v5.pt')
    ap.add_argument('--policy', default='policy_cnn')
    ap.add_argument('--games', type=int, default=3000)
    ap.add_argument('--seed-base', type=int, default=100000)
    ap.add_argument('--temp', type=float, default=1.0, help='softmax sampling temperature')
    ap.add_argument('--out', default='value_data')
    flags = ap.parse_args()

    from evaluate import _EnvShim
    policy = importlib.import_module(flags.policy).Policy(_EnvShim(nw.OBS_DIM))
    policy.load_state_dict(torch.load(flags.checkpoint, map_location='cpu'))
    policy.eval()

    rng = np.random.default_rng(0)
    all_obs, all_lab, all_game = [], [], []
    n_states = 0
    for g in range(flags.games):
        seed = flags.seed_base + g
        env = nw.NetworkWarsEnv(fixed_seed=seed)
        obs, _ = env.reset()
        traj = []
        while True:
            traj.append(obs.astype(np.float16))
            with torch.no_grad():
                logits, _ = policy.forward_eval(torch.as_tensor(obs).unsqueeze(0))
            probs = torch.softmax(logits[0] / flags.temp, dim=-1).numpy()
            probs = np.clip(probs, 0, None); probs /= probs.sum()
            action = int(rng.choice(N_ACTIONS, p=probs))
            obs, _, term, trunc, info = env.step(action)
            if term or trunc:
                label = 1.0 if info['score'] > 0.5 else 0.0
                for o in traj:
                    all_obs.append(o)
                    all_lab.append(label)
                    all_game.append(g)
                n_states += len(traj)
                break
        if (g + 1) % 250 == 0:
            wr = np.mean(all_lab) if all_lab else 0
            print(f'  {g+1}/{flags.games} games, {n_states} states, running label mean {wr:.3f}', flush=True)

    obs_arr = np.stack(all_obs).astype(np.float16)
    lab_arr = np.array(all_lab, dtype=np.float32)
    np.save(f'{flags.out}_obs.npy', obs_arr)
    np.save(f'{flags.out}_lab.npy', lab_arr)
    print(f'saved {flags.out}_obs.npy {obs_arr.shape}  label mean {lab_arr.mean():.3f}')


if __name__ == '__main__':
    main()
