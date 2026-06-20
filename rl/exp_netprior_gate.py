#!/usr/bin/env python3
"""GATE: can a board-level CNN predict the C-UCT search's move? Hand-features
capped at ~27% top-1 (< capprob-greedy 29%). If a CNN over the 7x6 board beats
that substantially, a net prior is learnable and worth wiring into fmcts's
root_pri hook (non-destructive). If it also caps ~30%, the net-prior lever is dead
and the ~80% plateau is confirmed unbeatable by any feedforward policy prior.

Plays the C-UCT (fastnw.uct_search, the ~80% Python-driven engine), dumps
(obs, chosen_cnn_action, visit_dist), trains a small CNN, reports top-1/top-3.
"""
import sys, time, numpy as np, torch, torch.nn as nn

import network_wars as nw
from network_wars import (HUMAN, BOTS, make_game, check_winner, counts, reinforce,
                          run_bot_turn, resolve_battle, NetworkWarsEnv, DIRS,
                          GRID_ROWS, GRID_COLS, N_CELLS, N_CELL_FEATS, N_GLOBALS,
                          N_ACTIONS, END_TURN)
import fastnw

WSET = [44.687, 69.885, 9.789, 1.754, 59.153, 114.472, 77.164, 9.322, 0, 60.487, 140.411, 0, 220.775]
GAMES = int(sys.argv[1]) if len(sys.argv) > 1 else 150
SIMS = int(sys.argv[2]) if len(sys.argv) > 2 else 2000
GC = N_CELLS * N_CELL_FEATS          # 336, start of globals
MASK0 = GC + N_GLOBALS               # start of action mask

def to_action_idx(state, frm, to):
    a, b = state.nodes[frm], state.nodes[to]
    return (a.y * GRID_COLS + a.x) * len(DIRS) + DIRS.index((b.y - a.y, b.x - a.x))

def dump():
    env = NetworkWarsEnv()
    OBS, TGT, VIS = [], [], []
    for s in range(1, GAMES + 1):
        state = make_game(s); fastnw.set_topology(state)
        fastnw.set_red_rollout_policy(1); fastnw.set_ranked_weights(WSET)
        fastnw.set_heur_priors(0, 0.02); fastnw.set_roll_temp(0.0)
        fastnw.set_ensemble([]); fastnw.set_safety_params(45.0, 28.0)
        fastnw.use_sim(0x12345678)
        env.state = state; env.turns = 1; turns = 1
        for _ in range(6000):
            if check_winner(state) is not None or counts(state)[HUMAN] == 0:
                break
            env.turns = turns
            obs = env._obs()
            owner, strength = fastnw.board_arrays(state)
            acts, visits = fastnw.uct_search(owner, strength, turns, SIMS, 2.5, 1, None)
            vvec = np.zeros(N_ACTIONS, np.float32)
            if len(acts) == 0:
                chosen = END_TURN; vvec[END_TURN] = 1.0
            else:
                for a, v in zip(acts, visits):
                    ai = END_TURN if int(a) == -1 else to_action_idx(state, int(a) >> 8, int(a) & 0xFF)
                    vvec[ai] += v
                best = int(acts[int(np.argmax(visits))])
                chosen = END_TURN if best == -1 else to_action_idx(state, best >> 8, best & 0xFF)
            OBS.append(obs.copy()); TGT.append(chosen); VIS.append(vvec)
            # apply chosen to real state
            if len(acts) == 0 or int(acts[int(np.argmax(visits))]) == -1:
                reinforce(state, HUMAN)
                if not check_winner(state):
                    for bot in BOTS:
                        run_bot_turn(state, bot)
                        if check_winner(state):
                            break
                turns += 1
            else:
                best = int(acts[int(np.argmax(visits))]); frm, to = best >> 8, best & 0xFF
                if state.nodes[frm].owner == HUMAN and state.nodes[frm].strength > 1 \
                        and state.nodes[to].owner != HUMAN and to in state.adj[frm]:
                    resolve_battle(state, frm, to)
            if turns > nw.MAX_TURNS:
                break
        if s % 30 == 0:
            print(f"  dumped {s} games, {len(OBS)} decisions", file=sys.stderr)
    return np.array(OBS), np.array(TGT), np.array(VIS)

def obs_to_img(O):
    n = len(O)
    cell = O[:, :GC].reshape(n, N_CELLS, N_CELL_FEATS).transpose(0, 2, 1).reshape(n, N_CELL_FEATS, GRID_ROWS, GRID_COLS)
    dirm = O[:, MASK0:MASK0 + N_CELLS * len(DIRS)].reshape(n, N_CELLS, len(DIRS)).transpose(0, 2, 1).reshape(n, len(DIRS), GRID_ROWS, GRID_COLS)
    glob = O[:, GC:GC + N_GLOBALS][:, :, None, None] * np.ones((1, 1, GRID_ROWS, GRID_COLS), np.float32)
    return np.concatenate([cell, dirm, glob], 1)   # (n, 28, 7, 6)

class CNN(nn.Module):
    def __init__(self, ch=64):
        super().__init__()
        inc = N_CELL_FEATS + len(DIRS) + N_GLOBALS
        self.t = nn.Sequential(nn.Conv2d(inc, ch, 3, padding=1), nn.GELU(),
                               nn.Conv2d(ch, ch, 3, padding=1), nn.GELU(),
                               nn.Conv2d(ch, ch, 3, padding=1), nn.GELU())
        self.act = nn.Conv2d(ch, len(DIRS), 1)
        self.end = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Linear(ch, 1))
    def forward(self, x):
        h = self.t(x)
        sp = self.act(h)                       # (n,8,7,6)
        n = x.shape[0]
        sp = sp.permute(0, 2, 3, 1).reshape(n, N_CELLS * len(DIRS))
        return torch.cat([sp, self.end(h)], 1)  # (n,337)

def main():
    t0 = time.time()
    O, T, V = dump()
    print(f"dumped {len(O)} decisions in {time.time()-t0:.0f}s", file=sys.stderr)
    img = torch.tensor(obs_to_img(O))
    mask = torch.tensor(O[:, MASK0:]).bool()   # (n,337) legal mask
    T = torch.tensor(T);
    g = torch.Generator().manual_seed(0); perm = torch.randperm(len(O), generator=g)
    ntr = int(len(O) * 0.85); tr, va = perm[:ntr], perm[ntr:]
    model = CNN()
    opt = torch.optim.Adam(model.parameters(), lr=2e-3, weight_decay=1e-5)
    for ep in range(120):
        model.train()
        idx = tr[torch.randperm(len(tr))]
        for b in range(0, len(idx), 256):
            j = idx[b:b+256]
            logits = model(img[j])
            logits = logits.masked_fill(~mask[j], -1e9)
            loss = nn.functional.cross_entropy(logits, T[j])
            opt.zero_grad(); loss.backward(); opt.step()
        if ep % 20 == 0 or ep == 119:
            model.eval()
            with torch.no_grad():
                lg = model(img[va]).masked_fill(~mask[va], -1e9)
                top1 = (lg.argmax(1) == T[va]).float().mean().item()
                top3 = (lg.topk(3,1).indices == T[va][:,None]).any(1).float().mean().item()
            print(f"ep {ep} val top1={top1:.3f} top3={top3:.3f}", file=sys.stderr)
    # baselines
    uni = (1.0 / mask[va].sum(1).float()).mean().item()
    print(f"GATE board-CNN top1={top1:.3f} top3={top3:.3f} | uniform~{uni:.3f} | hand-feat ceiling ~0.27", file=sys.stderr)

if __name__ == "__main__":
    main()
