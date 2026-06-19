"""Train a calibrated win-probability value net for Network Wars.

Reuses the CNN architecture (policy_cnn.Policy), warm-started from the v5
checkpoint, and fine-tunes it with BCE so that sigmoid(value_head) = P(RED win).
Only the value loss is optimised; the policy logits are ignored (we keep v5 for
MCTS priors and use this net only for the leaf value).

  uv run python train_value.py --data value_data --init policy_cnn_v5.pt \
      --epochs 8 --out value_cnn.pt
"""

import argparse

import numpy as np
import torch
import torch.nn as nn

import network_wars as nw
import policy_cnn
from evaluate import _EnvShim


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='value_data')
    ap.add_argument('--init', default='policy_cnn_v5.pt')
    ap.add_argument('--epochs', type=int, default=8)
    ap.add_argument('--batch', type=int, default=4096)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--val-frac', type=float, default=0.05)
    ap.add_argument('--out', default='value_cnn.pt')
    flags = ap.parse_args()

    obs = np.load(f'{flags.data}_obs.npy').astype(np.float32)
    lab = np.load(f'{flags.data}_lab.npy').astype(np.float32)
    print(f'data: {obs.shape} states, label mean {lab.mean():.3f}')

    n = len(obs)
    rng = np.random.default_rng(0)
    perm = rng.permutation(n)
    obs, lab = obs[perm], lab[perm]
    n_val = int(n * flags.val_frac)
    vx = torch.as_tensor(obs[:n_val]); vy = torch.as_tensor(lab[:n_val])
    tx = torch.as_tensor(obs[n_val:]); ty = torch.as_tensor(lab[n_val:])

    net = policy_cnn.Policy(_EnvShim(nw.OBS_DIM))
    net.load_state_dict(torch.load(flags.init, map_location='cpu'))
    opt = torch.optim.Adam(net.parameters(), lr=flags.lr)
    bce = nn.BCEWithLogitsLoss()

    def eval_val():
        net.eval()
        with torch.no_grad():
            preds = []
            for i in range(0, len(vx), 8192):
                _, v = net.forward_eval(vx[i:i+8192])
                preds.append(v[:, 0])
            v = torch.cat(preds)
            loss = bce(v, vy).item()
            acc = ((torch.sigmoid(v) > 0.5).float() == vy).float().mean().item()
        return loss, acc

    print(f'init   val: bce {eval_val()[0]:.4f}  acc {eval_val()[1]:.3f}')
    nt = len(tx)
    for ep in range(flags.epochs):
        net.train()
        order = torch.randperm(nt)
        tot = 0.0
        for i in range(0, nt, flags.batch):
            idx = order[i:i+flags.batch]
            _, v = net.forward_eval(tx[idx])
            loss = bce(v[:, 0], ty[idx])
            opt.zero_grad(); loss.backward(); opt.step()
            tot += loss.item() * len(idx)
        vl, va = eval_val()
        print(f'epoch {ep+1}: train bce {tot/nt:.4f}  val bce {vl:.4f}  val acc {va:.3f}', flush=True)

    torch.save(net.state_dict(), flags.out)
    print(f'saved {flags.out}')


if __name__ == '__main__':
    main()
