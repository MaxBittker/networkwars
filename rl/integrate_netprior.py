#!/usr/bin/env python3
"""Wire a board-CNN policy into the C-UCT as a ROOT prior (non-destructive: uses
the existing fastnw uct_search root_pri hook; touches no committed code).

Train CNN on the C-UCT's own move choices over TRAIN seeds, then eval win rate on
disjoint EVAL seeds WITH vs WITHOUT the prior. If the prior beats baseline, it's
the first real lever past ~80%.

Usage: uv run python integrate_netprior.py [train_games] [eval_games] [sims]
"""
import sys, time, numpy as np, torch, torch.nn as nn

import network_wars as nw
from network_wars import (HUMAN, BOTS, make_game, check_winner, counts, reinforce,
                          run_bot_turn, resolve_battle, NetworkWarsEnv, DIRS,
                          GRID_COLS, N_CELLS, N_CELL_FEATS, N_GLOBALS, N_ACTIONS,
                          END_TURN, legal_moves)
import fastnw
from exp_netprior_gate import CNN, obs_to_img, to_action_idx, GC, MASK0, WSET

PRI_END, PRI_LEN = 16192, 16193
TRAIN_G = int(sys.argv[1]) if len(sys.argv) > 1 else 250
EVAL_G  = int(sys.argv[2]) if len(sys.argv) > 2 else 200
SIMS    = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
TRAIN_SEED0 = 3001          # disjoint from eval seeds 1..EVAL_G

def _setup(state):
    fastnw.set_topology(state); fastnw.set_red_rollout_policy(1)
    fastnw.set_ranked_weights(WSET); fastnw.set_heur_priors(0, 0.02)
    fastnw.set_roll_temp(0.0); fastnw.set_ensemble([])
    fastnw.set_safety_params(45.0, 28.0); fastnw.use_sim(0x12345678)

def dump_games(lo, hi, sims):
    env = NetworkWarsEnv(); OBS, TGT, MASKS = [], [], []
    for s in range(lo, hi + 1):
        state = make_game(s); _setup(state); env.state = state; turns = 1
        for _ in range(6000):
            if check_winner(state) is not None or counts(state)[HUMAN] == 0: break
            env.turns = turns; o = env._obs()
            owner, strength = fastnw.board_arrays(state)
            acts, visits = fastnw.uct_search(owner, strength, turns, sims, 2.5, 1, None)
            if len(acts) == 0:
                chosen, end = END_TURN, True
            else:
                best = int(acts[int(np.argmax(visits))]); end = best == -1
                chosen = END_TURN if end else to_action_idx(state, best >> 8, best & 0xFF)
            OBS.append(o[:].copy()); TGT.append(chosen); MASKS.append(o[MASK0:].copy())
            if end:
                reinforce(state, HUMAN)
                if not check_winner(state):
                    for bot in BOTS:
                        run_bot_turn(state, bot)
                        if check_winner(state): break
                turns += 1
            else:
                frm, to = best >> 8, best & 0xFF
                if state.nodes[frm].owner == HUMAN and state.nodes[frm].strength > 1 \
                        and state.nodes[to].owner != HUMAN and to in state.adj[frm]:
                    resolve_battle(state, frm, to)
            if turns > nw.MAX_TURNS: break
    return np.array(OBS, np.float32), np.array(TGT), np.array(MASKS, np.float32)

def train_cnn(O, T, M, epochs=120):
    img = torch.tensor(obs_to_img(O)); mask = torch.tensor(M).bool(); T = torch.tensor(T)
    g = torch.Generator().manual_seed(0); perm = torch.randperm(len(O), generator=g)
    ntr = int(len(O) * 0.9); tr, va = perm[:ntr], perm[ntr:]
    model = CNN(); opt = torch.optim.Adam(model.parameters(), lr=2e-3, weight_decay=3e-4)
    best = 0.0; best_sd = {k: v.clone() for k, v in model.state_dict().items()}
    for ep in range(epochs):
        model.train(); idx = tr[torch.randperm(len(tr))]
        for b in range(0, len(idx), 256):
            j = idx[b:b+256]
            lg = model(img[j]).masked_fill(~mask[j], -1e9)
            loss = nn.functional.cross_entropy(lg, T[j])
            opt.zero_grad(); loss.backward(); opt.step()
        model.eval()
        with torch.no_grad():
            lg = model(img[va]).masked_fill(~mask[va], -1e9)
            t1 = (lg.argmax(1) == T[va]).float().mean().item()
        if t1 > best:
            best = t1; best_sd = {k: v.clone() for k, v in model.state_dict().items()}
        if ep % 10 == 0 or ep == epochs - 1:
            print(f"  train ep {ep} val top1={t1:.3f} (best {best:.3f})", file=sys.stderr)
    model.load_state_dict(best_sd)        # deploy the BEST, not the overfit last epoch
    return model, best

def make_pri(model, env, state, turns, owner, strength):
    env.state = env.state  # state already set by caller via env.state=state
    o = env._obs()
    img = torch.tensor(obs_to_img(o[None]))
    mask = torch.tensor(o[None, MASK0:]).bool()
    with torch.no_grad():
        p = torch.softmax(model(img).masked_fill(~mask, -1e9), 1).numpy()[0]
    pri = np.zeros(PRI_LEN, np.float64)
    for frm, to in legal_moves(state, HUMAN):
        pri[(frm << 8) | to] = p[to_action_idx(state, frm, to)]
    pri[PRI_END] = p[END_TURN]
    return pri

def eval_winrate(lo, hi, sims, model=None):
    env = NetworkWarsEnv() if model is not None else None
    wins = 0
    for s in range(lo, hi + 1):
        state = make_game(s); _setup(state); turns = 1
        if env is not None: env.state = state
        for _ in range(6000):
            if check_winner(state) is not None or counts(state)[HUMAN] == 0: break
            owner, strength = fastnw.board_arrays(state)
            root_pri = None
            if model is not None:
                env.state = state; env.turns = turns
                root_pri = make_pri(model, env, state, turns, owner, strength)
            acts, visits = fastnw.uct_search(owner, strength, turns, sims, 2.5, 1, root_pri)
            if len(acts) == 0 or int(acts[int(np.argmax(visits))]) == -1:
                reinforce(state, HUMAN)
                if not check_winner(state):
                    for bot in BOTS:
                        run_bot_turn(state, bot)
                        if check_winner(state): break
                turns += 1
            else:
                best = int(acts[int(np.argmax(visits))]); frm, to = best >> 8, best & 0xFF
                if state.nodes[frm].owner == HUMAN and state.nodes[frm].strength > 1 \
                        and state.nodes[to].owner != HUMAN and to in state.adj[frm]:
                    resolve_battle(state, frm, to)
                else:
                    reinforce(state, HUMAN)
                    if not check_winner(state):
                        for bot in BOTS:
                            run_bot_turn(state, bot)
                            if check_winner(state): break
                    turns += 1
            if turns > nw.MAX_TURNS: break
        if check_winner(state) == HUMAN: wins += 1
    return wins, hi - lo + 1

def main():
    t0 = time.time()
    print(f"[1] dump train seeds {TRAIN_SEED0}..{TRAIN_SEED0+TRAIN_G-1} @ {SIMS} sims", file=sys.stderr)
    O, T, M = dump_games(TRAIN_SEED0, TRAIN_SEED0 + TRAIN_G - 1, SIMS)
    print(f"    {len(O)} decisions in {time.time()-t0:.0f}s", file=sys.stderr)
    print("[2] train CNN", file=sys.stderr)
    model, top1 = train_cnn(O, T, M)
    print(f"    final val top1={top1:.3f}", file=sys.stderr)
    print(f"[3] eval baseline (no prior) seeds 1..{EVAL_G}", file=sys.stderr)
    w0, n0 = eval_winrate(1, EVAL_G, SIMS, None)
    print(f"    BASELINE: {w0}/{n0} = {w0/n0*100:.1f}%", file=sys.stderr)
    print(f"[4] eval WITH CNN root prior seeds 1..{EVAL_G}", file=sys.stderr)
    w1, n1 = eval_winrate(1, EVAL_G, SIMS, model)
    print(f"    CNN-PRIOR: {w1}/{n1} = {w1/n1*100:.1f}%", file=sys.stderr)
    print(f"=== baseline {w0/n0*100:.1f}% vs cnn-prior {w1/n1*100:.1f}% (top1={top1:.3f}) "
          f"total {time.time()-t0:.0f}s ===", file=sys.stderr)

if __name__ == "__main__":
    main()
