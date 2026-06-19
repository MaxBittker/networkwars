"""Supervised AlphaGo-style net: imitate modalScout's moves (policy head, CE)
and predict game outcome (value head, BCE), from replayed expert data.

  uv run python train_sl.py --data expert --init policy_cnn_v5.pt \
      --epochs 20 --out sl_cnn.pt
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
    ap.add_argument('--data', default='expert')
    ap.add_argument('--init', default='policy_cnn_v5.pt')
    ap.add_argument('--epochs', type=int, default=20)
    ap.add_argument('--batch', type=int, default=2048)
    ap.add_argument('--lr', type=float, default=8e-4)
    ap.add_argument('--wd', type=float, default=1e-4)
    ap.add_argument('--value-coef', type=float, default=1.0)
    ap.add_argument('--val-frac', type=float, default=0.05)
    ap.add_argument('--out', default='sl_cnn.pt')
    flags = ap.parse_args()

    obs = np.load(f'{flags.data}_obs.npy').astype(np.float32)
    pol = np.load(f'{flags.data}_pol.npy').astype(np.int64)
    val = np.load(f'{flags.data}_val.npy').astype(np.float32)
    print(f'data: {obs.shape} states, value mean {val.mean():.3f}')

    n = len(obs)
    rng = np.random.default_rng(0)
    perm = rng.permutation(n)
    obs, pol, val = obs[perm], pol[perm], val[perm]
    nv = int(n * flags.val_frac)
    vx, vp, vy = (torch.as_tensor(obs[:nv]), torch.as_tensor(pol[:nv]), torch.as_tensor(val[:nv]))
    tx, tp, ty = (torch.as_tensor(obs[nv:]), torch.as_tensor(pol[nv:]), torch.as_tensor(val[nv:]))

    net = policy_cnn.Policy(_EnvShim(nw.OBS_DIM))
    if flags.init:
        net.load_state_dict(torch.load(flags.init, map_location='cpu'))
    opt = torch.optim.Adam(net.parameters(), lr=flags.lr, weight_decay=flags.wd)
    ce = nn.CrossEntropyLoss()
    bce = nn.BCEWithLogitsLoss()

    def evaluate():
        net.eval()
        with torch.no_grad():
            pl, vlh = [], []
            for i in range(0, len(vx), 8192):
                lg, v = net.forward_eval(vx[i:i+8192])
                pl.append(lg); vlh.append(v[:, 0])
            lg = torch.cat(pl); v = torch.cat(vlh)
            pacc = (lg.argmax(1) == vp).float().mean().item()
            vacc = ((torch.sigmoid(v) > 0.5).float() == vy).float().mean().item()
            vbce = bce(v, vy).item()
        return pacc, vacc, vbce

    pacc, vacc, vbce = evaluate()
    print(f'init   val: pol-acc {pacc:.3f}  val-acc {vacc:.3f}  val-bce {vbce:.4f}')
    nt = len(tx)
    for ep in range(flags.epochs):
        net.train()
        order = torch.randperm(nt)
        tot_p = tot_v = 0.0
        for i in range(0, nt, flags.batch):
            idx = order[i:i+flags.batch]
            lg, v = net.forward_eval(tx[idx])
            lp = ce(lg, tp[idx])
            lv = bce(v[:, 0], ty[idx])
            loss = lp + flags.value_coef * lv
            opt.zero_grad(); loss.backward(); opt.step()
            tot_p += lp.item() * len(idx); tot_v += lv.item() * len(idx)
        pacc, vacc, vbce = evaluate()
        print(f'epoch {ep+1}: train pol-ce {tot_p/nt:.4f} val-bce {tot_v/nt:.4f} | '
              f'val pol-acc {pacc:.3f} val-acc {vacc:.3f} val-bce {vbce:.4f}', flush=True)
        torch.save(net.state_dict(), flags.out)   # checkpoint every epoch

    print(f'saved {flags.out}')


if __name__ == '__main__':
    main()
