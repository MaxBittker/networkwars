"""Evaluate a trained policy on the same fixed seeds as the JS benchmark.

Usage: uv run python evaluate.py [checkpoint] [--games 200] [--sample]

Plays game seeds 1..games (identical boards/battles to `node sim.js` thanks to
the verified engine port) and reports winrate, comparable directly to the
sample policies in sim.js.
"""

import argparse
import importlib
import json

import numpy as np
import torch

from network_wars import NetworkWarsEnv, N_ACTIONS


class _SpaceShim:
    def __init__(self, shape):
        self.shape = shape


class _EnvShim:
    def __init__(self, obs_dim):
        self.single_observation_space = _SpaceShim((obs_dim,))


def play(policy, seed, sample=False, rng=None):
    env = NetworkWarsEnv(fixed_seed=seed)
    obs, _ = env.reset()
    while True:
        with torch.no_grad():
            logits, _ = policy.forward_eval(torch.as_tensor(obs).unsqueeze(0))
        if sample:
            probs = torch.softmax(logits[0], dim=-1).numpy()
            action = rng.choice(N_ACTIONS, p=probs / probs.sum())
        else:
            action = int(logits[0].argmax())
        obs, _, term, trunc, info = env.step(action)
        if term or trunc:
            return info['score'] > 0.5, info['game_turns']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('checkpoint', nargs='?', default='policy_final.pt')
    ap.add_argument('--games', type=int, default=200)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--policy', type=str, default='policy',
                    help='module with a Policy class (policy | policy_cnn)')
    ap.add_argument('--sample', action='store_true', help='sample instead of argmax')
    ap.add_argument('--quiet', action='store_true', help='emit machine-readable JSON only')
    flags = ap.parse_args()

    from network_wars import OBS_DIM
    policy = importlib.import_module(flags.policy).Policy(_EnvShim(OBS_DIM))
    policy.load_state_dict(torch.load(flags.checkpoint, map_location='cpu'))
    policy.eval()

    rng = np.random.default_rng(0)
    wins, turns_to_win, total_turns = 0, [], 0
    for seed in range(flags.seed_base, flags.seed_base + flags.games):
        won, turns = play(policy, seed, sample=flags.sample, rng=rng)
        total_turns += turns
        if won:
            wins += 1
            turns_to_win.append(turns)

    mode = 'sampled' if flags.sample else 'argmax'
    avg_turns_to_win = float(np.mean(turns_to_win)) if turns_to_win else None
    avg = f'{avg_turns_to_win:.2f}' if avg_turns_to_win is not None else '—'
    if flags.quiet:
        print(json.dumps({
            'checkpoint': flags.checkpoint,
            'mode': mode,
            'games': flags.games,
            'seedBase': flags.seed_base,
            'wins': wins,
            'avgTurnsToWin': avg_turns_to_win,
            'avgGameLength': total_turns / flags.games,
        }))
        return

    print(f'{flags.checkpoint} ({mode}): winrate {wins}/{flags.games} '
          f'= {wins / flags.games * 100:.1f}%  avgTurns→win {avg}')


if __name__ == '__main__':
    main()
