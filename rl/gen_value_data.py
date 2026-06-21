"""Generate (board-features -> eventual RED win) data from C-UCT self-play, to FIT
a calibrated static leaf-value heuristic. Each red-decision state is logged with
cheap features and tagged with the game's final outcome.

  python gen_value_data.py --games 150 --sims 800 --out /tmp/valdata.npz
"""
import argparse, time
import numpy as np
import network_wars as nw
from network_wars import HUMAN, BOTS, make_game, check_winner, counts, reinforce, run_bot_turn, resolve_battle
import fastnw
from fmcts import WSETS


def features(state, turns):
    c = counts(state)
    facs = ['red', 'green', 'yellow', 'blue', 'purple']
    nodes = {f: c.get(f, 0) for f in facs}
    strg = {f: 0 for f in facs}
    for n in state.nodes:
        strg[n.owner] = strg.get(n.owner, 0) + n.strength
    red_n = nodes['red']
    enemy_n = [nodes[f] for f in facs if f != 'red']
    max_en = max(enemy_n)
    sum_en = sum(enemy_n)
    red_s = strg['red']
    max_es = max(strg[f] for f in facs if f != 'red')
    # red's largest connected component (board control / fracture)
    comps = nw.components_of(state, 'red')
    red_big = max((len(x) for x in comps), default=0)
    return np.array([
        1.0,                      # bias
        red_n,                    # red node count (toward 24)
        red_n - max_en,           # margin vs strongest enemy
        red_n - sum_en / 4.0,     # margin vs avg enemy
        red_s - max_es,           # strength margin
        red_big,                  # largest red component
        red_big - red_n,          # fracture (0 = fully connected)
        float(turns),
    ], dtype=np.float64)


def play_and_log(seed, sims, X, Y, c_puct=2.5, wset='C1'):
    state = make_game(seed)
    fastnw.set_topology(state)
    fastnw.set_red_rollout_policy(1)
    fastnw.set_ranked_weights(WSETS[wset])
    fastnw.set_heur_priors(0, 0.02)
    fastnw.set_roll_temp(0.0)
    fastnw.set_ensemble([])
    fastnw.use_sim(0x12345678)
    turns = 1
    feats = []
    for _ in range(6000):
        if check_winner(state) is not None or counts(state)[HUMAN] == 0:
            break
        feats.append(features(state, turns))
        owner, strength = fastnw.board_arrays(state)
        acts, visits = fastnw.uct_search(owner, strength, turns, sims, c_puct, 1, None)
        action = int(acts[int(np.argmax(visits))]) if len(acts) else -1
        if action == -1:
            reinforce(state, HUMAN)
            if not check_winner(state):
                for b in BOTS:
                    run_bot_turn(state, b)
                    if check_winner(state):
                        break
            turns += 1
        else:
            frm, to = action >> 8, action & 0xFF
            if state.nodes[frm].owner == HUMAN and state.nodes[frm].strength > 1 \
                    and state.nodes[to].owner != HUMAN and to in state.adj[frm]:
                resolve_battle(state, frm, to)
            else:
                reinforce(state, HUMAN)
                if not check_winner(state):
                    for b in BOTS:
                        run_bot_turn(state, b)
                        if check_winner(state):
                            break
                turns += 1
        if turns > nw.MAX_TURNS:
            break
    won = 1.0 if check_winner(state) == HUMAN else 0.0
    for f in feats:
        X.append(f); Y.append(won)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=150)
    ap.add_argument('--sims', type=int, default=800)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--out', default='/tmp/valdata.npz')
    a = ap.parse_args()
    X, Y = [], []
    t0 = time.time()
    for s in range(a.seed_base, a.seed_base + a.games):
        play_and_log(s, a.sims, X, Y)
    X = np.array(X); Y = np.array(Y)
    np.savez(a.out, X=X, Y=Y)
    print(f"logged {len(Y)} states from {a.games} games, winrate={Y.mean():.3f}, "
          f"{time.time()-t0:.0f}s -> {a.out}")


if __name__ == '__main__':
    main()
