"""Train a Network Wars policy with PufferLib PPO (pufferl).

Usage: uv run python train.py [--timesteps 10000000] [--num-envs 192] [--out policy_final.pt]
"""

import argparse
import importlib
import sys

import torch

import pufferlib.emulation
import pufferlib.vector
import pufferlib.pufferl as pufferl

from network_wars import NetworkWarsEnv


def env_creator(seed=0, buf=None):
    return pufferlib.emulation.GymnasiumPufferEnv(
        env_creator=lambda: NetworkWarsEnv(seed=seed), buf=buf, seed=seed)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--timesteps', type=int, default=10_000_000)
    ap.add_argument('--num-envs', type=int, default=192)
    ap.add_argument('--num-workers', type=int, default=8)
    ap.add_argument('--lr', type=float, default=0.015)
    ap.add_argument('--gamma', type=float, default=0.97)
    ap.add_argument('--ent-coef', type=float, default=0.001)
    ap.add_argument('--policy', type=str, default='policy',
                    help='module with a Policy class (policy | policy_cnn)')
    ap.add_argument('--resume', type=str, default=None,
                    help='checkpoint to initialize weights from')
    ap.add_argument('--out', type=str, default='policy_final.pt')
    flags = ap.parse_args()

    sys.argv = sys.argv[:1]  # keep pufferl's own arg parser quiet
    args = pufferl.load_config('default')
    args['train'].update(
        device='cpu',
        total_timesteps=flags.timesteps,
        learning_rate=flags.lr,
        bptt_horizon=64,
        batch_size='auto',          # num_envs * horizon
        minibatch_size=6144,
        gamma=flags.gamma,
        ent_coef=flags.ent_coef,
        checkpoint_interval=200,
        compile=False,
    )

    vecenv = pufferlib.vector.make(
        env_creator,
        num_envs=flags.num_envs,
        num_workers=flags.num_workers,
        backend=pufferlib.vector.Multiprocessing,
        seed=42,
    )
    policy = importlib.import_module(flags.policy).Policy(vecenv)
    if flags.resume:
        policy.load_state_dict(torch.load(flags.resume, map_location='cpu'))

    train_config = dict(**args['train'], env='network-wars')
    trainer = pufferl.PuffeRL(train_config, vecenv, policy)

    while trainer.global_step < flags.timesteps:
        trainer.evaluate()
        trainer.train()

    trainer.print_dashboard()
    trainer.close()
    torch.save(policy.state_dict(), flags.out)
    print(f'saved {flags.out}')


if __name__ == '__main__':
    main()
