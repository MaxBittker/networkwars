"""Masked MLP policy for Network Wars.

The legal-action mask is the last N_ACTIONS entries of the observation, so
masking happens entirely inside forward() — the PufferLib trainer needs no
special support: sampled actions and recomputed logprobs are always legal.
"""

import torch
import torch.nn as nn

import pufferlib.pytorch

from network_wars import N_ACTIONS


class Policy(nn.Module):
    def __init__(self, env, hidden_size=256):
        super().__init__()
        self.hidden_size = hidden_size
        obs_dim = env.single_observation_space.shape[0]
        self.encoder = nn.Sequential(
            pufferlib.pytorch.layer_init(nn.Linear(obs_dim, hidden_size)),
            nn.GELU(),
            pufferlib.pytorch.layer_init(nn.Linear(hidden_size, hidden_size)),
            nn.GELU(),
        )
        self.actor = pufferlib.pytorch.layer_init(
            nn.Linear(hidden_size, N_ACTIONS), std=0.01)
        self.value = pufferlib.pytorch.layer_init(
            nn.Linear(hidden_size, 1), std=1)

    def forward(self, observations, state=None):
        return self.forward_eval(observations, state)

    def forward_eval(self, observations, state=None):
        x = observations.float()
        hidden = self.encoder(x)
        logits = self.actor(hidden)
        mask = x[:, -N_ACTIONS:]
        logits = logits.masked_fill(mask < 0.5, -1e9)
        return logits, self.value(hidden)
