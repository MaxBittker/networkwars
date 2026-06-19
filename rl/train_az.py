"""AlphaZero-style retraining from self-play data: policy head learns the MCTS
visit distribution (soft cross-entropy), value head learns the outcome (BCE).

Mixes self-play data with the SL-expert data (replay buffer) for stability.

  uv run python train_az.py --sp sp0 --expert expert --init sl_cnn.pt \
      --epochs 6 --out az1.pt
"""

import argparse

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import network_wars as nw
import policy_cnn
from evaluate import _EnvShim
from network_wars import N_ACTIONS


def load_sp(prefixes):
    """Accepts a comma-separated list of self-play prefixes (replay buffer)."""
    obs_l, pi_l, z_l = [], [], []
    for prefix in prefixes.split(','):
        prefix = prefix.strip()
        if not prefix:
            continue
        obs_l.append(np.load(f'{prefix}_obs.npy').astype(np.float32))
        pi_l.append(np.load(f'{prefix}_pi.npy').astype(np.float32))
        z_l.append(np.load(f'{prefix}_z.npy').astype(np.float32))
    return np.concatenate(obs_l), np.concatenate(pi_l), np.concatenate(z_l)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sp', default='sp0', help='self-play data prefix')
    ap.add_argument('--expert', default='expert', help='SL-expert data prefix (one-hot policy)')
    ap.add_argument('--expert-frac', type=float, default=0.3,
                    help='fraction of expert states to mix in for stability')
    ap.add_argument('--init', default='sl_cnn.pt')
    ap.add_argument('--epochs', type=int, default=6)
    ap.add_argument('--batch', type=int, default=2048)
    ap.add_argument('--lr', type=float, default=5e-4)
    ap.add_argument('--wd', type=float, default=1e-4)
    ap.add_argument('--out', default='az.pt')
    flags = ap.parse_args()

    obs, pi, z = load_sp(flags.sp)
    print(f'self-play: {obs.shape} states, value mean {z.mean():.3f}')

    if flags.expert and flags.expert_frac > 0:
        eo = np.load(f'{flags.expert}_obs.npy').astype(np.float32)
        ep = np.load(f'{flags.expert}_pol.npy').astype(np.int64)
        ez = np.load(f'{flags.expert}_val.npy').astype(np.float32)
        k = int(len(eo) * flags.expert_frac)
        idx = np.random.default_rng(0).choice(len(eo), size=min(k, len(eo)), replace=False)
        epi = np.zeros((len(idx), N_ACTIONS), dtype=np.float32)
        epi[np.arange(len(idx)), ep[idx]] = 1.0
        obs = np.concatenate([obs, eo[idx]]); pi = np.concatenate([pi, epi]); z = np.concatenate([z, ez[idx]])
        print(f'mixed in {len(idx)} expert states -> {obs.shape}')

    n = len(obs)
    rng = np.random.default_rng(0)
    perm = rng.permutation(n)
    obs, pi, z = obs[perm], pi[perm], z[perm]
    nv = int(n * 0.05)
    vx, vpi, vz = torch.as_tensor(obs[:nv]), torch.as_tensor(pi[:nv]), torch.as_tensor(z[:nv])
    tx, tpi, tz = torch.as_tensor(obs[nv:]), torch.as_tensor(pi[nv:]), torch.as_tensor(z[nv:])

    net = policy_cnn.Policy(_EnvShim(nw.OBS_DIM))
    net.load_state_dict(torch.load(flags.init, map_location='cpu'))
    opt = torch.optim.Adam(net.parameters(), lr=flags.lr, weight_decay=flags.wd)
    bce = nn.BCEWithLogitsLoss()

    def soft_ce(logits, target):
        return -(target * F.log_softmax(logits, dim=1)).sum(1).mean()

    def evaluate():
        net.eval()
        with torch.no_grad():
            lps, vs = [], []
            for i in range(0, len(vx), 8192):
                lg, v = net.forward_eval(vx[i:i+8192]); lps.append(lg); vs.append(v[:, 0])
            lg = torch.cat(lps); v = torch.cat(vs)
            pce = soft_ce(lg, vpi).item()
            vacc = ((torch.sigmoid(v) > 0.5).float() == vz).float().mean().item()
        return pce, vacc

    pce, vacc = evaluate()
    print(f'init val: pol-ce {pce:.4f} val-acc {vacc:.3f}')
    nt = len(tx)
    for ep in range(flags.epochs):
        net.train()
        order = torch.randperm(nt)
        tp = tv = 0.0
        for i in range(0, nt, flags.batch):
            idx = order[i:i+flags.batch]
            lg, v = net.forward_eval(tx[idx])
            lp = soft_ce(lg, tpi[idx]); lv = bce(v[:, 0], tz[idx])
            loss = lp + lv
            opt.zero_grad(); loss.backward(); opt.step()
            tp += lp.item() * len(idx); tv += lv.item() * len(idx)
        pce, vacc = evaluate()
        print(f'epoch {ep+1}: train pol-ce {tp/nt:.4f} val-bce {tv/nt:.4f} | '
              f'val pol-ce {pce:.4f} val-acc {vacc:.3f}', flush=True)
        torch.save(net.state_dict(), flags.out)

    print(f'saved {flags.out}')


if __name__ == '__main__':
    main()
