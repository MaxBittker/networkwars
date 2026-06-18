"""CNN policy for Network Wars.

Treats the board as a 6x6 image. Input channels: 7 board features, the 8
per-direction legal-move planes (the action mask reshaped), and 6 broadcast
globals = 21 channels. The actor head is spatial: a 1x1 conv emits 8 direction
logits per cell (aligned with the cell*8+dir action indexing), and the
end-turn logit comes from the pooled trunk. Illegal logits are masked to -1e9,
same contract as the MLP policy.
"""

import torch
import torch.nn as nn

import pufferlib.pytorch

from network_wars import (
    N_ACTIONS, N_CELLS, N_CELL_FEATS, N_GLOBALS, GRID_ROWS, GRID_COLS, DIRS,
)

N_DIRS = len(DIRS)
GRID_FEATS = N_CELLS * N_CELL_FEATS


class Policy(nn.Module):
    def __init__(self, env, hidden_size=512, channels=64):
        super().__init__()
        self.hidden_size = hidden_size
        in_ch = N_CELL_FEATS + N_DIRS + N_GLOBALS  # 7 + 8 + 6 = 21
        self.trunk = nn.Sequential(
            pufferlib.pytorch.layer_init(nn.Conv2d(in_ch, channels, 3, padding=1)),
            nn.GELU(),
            pufferlib.pytorch.layer_init(nn.Conv2d(channels, channels, 3, padding=1)),
            nn.GELU(),
            pufferlib.pytorch.layer_init(nn.Conv2d(channels, channels, 3, padding=1)),
            nn.GELU(),
        )
        self.actor_spatial = pufferlib.pytorch.layer_init(
            nn.Conv2d(channels, N_DIRS, 1), std=0.01)
        self.head = nn.Sequential(
            pufferlib.pytorch.layer_init(
                nn.Linear(channels * N_CELLS, hidden_size)),
            nn.GELU(),
        )
        self.end_turn_logit = pufferlib.pytorch.layer_init(
            nn.Linear(hidden_size, 1), std=0.01)
        self.value = pufferlib.pytorch.layer_init(
            nn.Linear(hidden_size, 1), std=1)

    def forward(self, observations, state=None):
        return self.forward_eval(observations, state)

    def forward_eval(self, observations, state=None):
        x = observations.float()
        b = x.shape[0]
        # board: (B, 36*7) -> (B, 7, 6, 6); cells are row-major y*6+x
        board = x[:, :GRID_FEATS].view(b, N_CELLS, N_CELL_FEATS)
        board = board.permute(0, 2, 1).reshape(b, N_CELL_FEATS, GRID_ROWS, GRID_COLS)
        # globals broadcast to planes
        glob = x[:, GRID_FEATS:GRID_FEATS + N_GLOBALS]
        glob = glob.view(b, N_GLOBALS, 1, 1).expand(b, N_GLOBALS, GRID_ROWS, GRID_COLS)
        # mask: (B, 289); attack part -> (B, 8, 6, 6) per-direction legality planes
        mask = x[:, -N_ACTIONS:]
        attack_mask = mask[:, :N_CELLS * N_DIRS].view(b, N_CELLS, N_DIRS)
        mask_planes = attack_mask.permute(0, 2, 1).reshape(b, N_DIRS, GRID_ROWS, GRID_COLS)

        feat = self.trunk(torch.cat([board, mask_planes, glob], dim=1))
        hidden = self.head(feat.reshape(b, -1))

        # (B, 8, 6, 6) -> cell-major, dir-minor = action index (y*6+x)*8 + d
        attack_logits = self.actor_spatial(feat).permute(0, 2, 3, 1).reshape(b, -1)
        logits = torch.cat([attack_logits, self.end_turn_logit(hidden)], dim=1)
        logits = logits.masked_fill(mask < 0.5, -1e9)
        return logits, self.value(hidden)
