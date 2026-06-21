"""Offline tuning harness — find configs that LOSE LESS vs the (confirmed
deterministic) bots. Reuses fmcts mechanics but lets sims vary per round so we
can test opening front-loading (losses are decided rounds 0-3, see analysis).

Paired over a shared seed set so configs are compared on the SAME games (low
variance). Reports winrate + loss profile (how fast/how badly red dies).

  python tune_lossless.py --games 200 --base 3200
"""
import argparse, time
import numpy as np
import network_wars as nw
from network_wars import HUMAN, BOTS, make_game, check_winner, counts, reinforce, run_bot_turn, resolve_battle
import fastnw
from fmcts import WSETS


_VALW = None
def _load_valw():
    global _VALW
    if _VALW is None:
        _VALW = np.load('/tmp/value_w.npy')
    return _VALW


def play(seed, sims_fn, c_puct=2.5, nroll=1, wset="C1", policy=1, vtrunc=None, sim_seed=0x12345678):
    state = make_game(seed)
    fastnw.set_topology(state)
    fastnw.set_red_rollout_policy(policy)
    fastnw.set_ranked_weights(WSETS[wset])
    fastnw.set_heur_priors(0, 0.02)
    fastnw.set_roll_temp(0.0)
    fastnw.set_ensemble([])
    fastnw.set_safety_params(45.0, 28.0)
    if vtrunc is not None or policy == 3:
        fastnw.set_value_weights(_load_valw())
    fastnw.set_leaf_trunc(vtrunc if vtrunc is not None else -1)
    fastnw.use_sim(sim_seed)
    turns = 1
    for _ in range(6000):
        w = check_winner(state)
        if w is not None or counts(state)[HUMAN] == 0:
            break
        owner, strength = fastnw.board_arrays(state)
        sims = sims_fn(turns)
        acts, visits = fastnw.uct_search(owner, strength, turns, sims, c_puct, nroll, None)
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
    won = check_winner(state) == HUMAN
    return won, turns, counts(state)[HUMAN]


def play_adaptive(seed, sims, c_puct=2.5, nroll=1, wset="C1",
                  behind=0.45, sim_seed=0x12345678):
    """Behind-aware: search with the aggressive ranked rollout (policy 1); if the
    best child's Q (red win-prob) is below `behind`, re-search with the safety-aware
    rollout (policy 2) and play THAT move. Aggressive when winning, cautious when
    losing — targeting fewer fast collapses."""
    state = make_game(seed)
    fastnw.set_topology(state)
    fastnw.set_ranked_weights(WSETS[wset])
    fastnw.set_heur_priors(0, 0.02)
    fastnw.set_roll_temp(0.0)
    fastnw.set_ensemble([])
    fastnw.set_safety_params(45.0, 28.0)
    fastnw.use_sim(sim_seed)
    turns = 1
    for _ in range(6000):
        if check_winner(state) is not None or counts(state)[HUMAN] == 0:
            break
        owner, strength = fastnw.board_arrays(state)
        fastnw.set_red_rollout_policy(1)
        acts, visits, q = fastnw.uct_search(owner, strength, turns, sims, c_puct, nroll, None, return_q=True)
        if len(acts):
            bi = int(np.argmax(visits))
            if q[bi] < behind:   # losing -> reconsider with the cautious policy
                fastnw.set_red_rollout_policy(2)
                acts, visits, q = fastnw.uct_search(owner, strength, turns, sims, c_puct, nroll, None, return_q=True)
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
    return check_winner(state) == HUMAN, turns, counts(state)[HUMAN]


def flat(n):
    return lambda t: n


def frontload(opening, late, k=3):
    return lambda t: opening if t <= k else late


def run_config(name, seeds, sims_fn, adaptive=False, base=1600, **kw):
    t0 = time.time()
    wins = 0
    loss_turns, loss_red = [], []
    for s in seeds:
        if adaptive:
            won, turns, red = play_adaptive(s, base, **kw)
        else:
            won, turns, red = play(s, sims_fn, **kw)
        if won:
            wins += 1
        else:
            loss_turns.append(turns)
            loss_red.append(red)
    dt = time.time() - t0
    n = len(seeds)
    wr = wins / n * 100
    se = (wr * (100 - wr) / n) ** 0.5
    import statistics as st
    lt = f"{st.mean(loss_turns):.1f}" if loss_turns else "-"
    lr = f"{st.mean(loss_red):.1f}" if loss_red else "-"
    print(f"  {name:30} {wr:5.1f}% ±{se:3.1f}  ({wins}/{n})  "
          f"loss_turns={lt} loss_red={lr}  [{dt:.0f}s]")
    return wr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=200)
    ap.add_argument('--base', type=int, default=3200)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--configs', default='baseline,frontload_extra,frontload_neutral,policy2')
    args = ap.parse_args()
    seeds = list(range(args.seed_base, args.seed_base + args.games))
    B = args.base
    print(f"=== tune_lossless: {args.games} games, base sims={B}, paired seeds ===")

    cfgs = {
        'baseline':           (flat(B), {}),
        # extra compute in opening (pure-upside check): 3x base rounds<=3
        'frontload_extra':    (frontload(B * 3, B, 3), {}),
        # compute-neutral-ish: big opening, small late (avg ~ base over a ~9-round game)
        'frontload_neutral':  (frontload(B * 3, B // 2, 3), {}),
        'policy2_safety':     (flat(B), {'policy': 2}),
        'cpuct1.5':           (flat(B), {'c_puct': 1.5}),
        'cpuct4':             (flat(B), {'c_puct': 4.0}),
        'nroll2':             (flat(B), {'nroll': 2}),
        'nroll3':             (flat(B), {'nroll': 3}),
        'nroll5':             (flat(B), {'nroll': 5}),
        'adaptive_behind':    (flat(B), {'adaptive': True, 'base': B}),
        'vtrunc0':            (flat(B), {'vtrunc': 0}),   # pure static value leaf
        'vtrunc2':            (flat(B), {'vtrunc': 2}),   # 2-ply rollout + value
        'vtrunc4':            (flat(B), {'vtrunc': 4}),
        'vtrunc8':            (flat(B), {'vtrunc': 8}),
        'valpolicy':          (flat(B), {'policy': 3}),            # value-greedy red rollout
        'valpolicy_trunc4':   (flat(B), {'policy': 3, 'vtrunc': 4}),
    }
    for name in args.configs.split(','):
        if name in cfgs:
            fn, kw = cfgs[name]
            run_config(name, seeds, fn, **kw)


if __name__ == '__main__':
    main()
