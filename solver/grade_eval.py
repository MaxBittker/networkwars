"""Does grading mode (uct_set_grade) measure root moves more accurately?

The blunder/grading flows need SEMI-ACCURATE Qs for many root moves, not just the
argmax pick. Plain UCT starves non-best children, so their Qs are contaminated by
burn-in sims and lean on the pessimistic C1 rollout — gaps vs best come out
inflated. Grading mode adds a root min-visit floor + drops dominance early-stops +
reports second-half Qs. This harness measures whether that actually helps:

  - sample live midgame positions (best-Q in 10-90%) from self-play,
  - per position, compute a TRUTH Q per root move: 200k-sim grade-mode search on a
    DIFFERENT sim stream (floor => every move gets >=~2k visits, SE ~<0.01),
  - estimate the same position at review budget (8k fixed) three ways:
      mode 0 (normal search), mode 2 (floor+stops, cumulative Q),
      mode 1 (floor+stops + second-half Q),
  - score each estimator vs truth: mean |dQ| over all moves / top-5 moves, signed
    bias on non-best moves (pessimism), and |gap-to-best error| (the blunder metric).

RESULTS (2026-07-18, 24 positions, truth @200k):
  @ 8k:  |dQ| 0.134 -> 0.107, non-best bias -0.129 -> -0.098, |gap err| 0.095 -> 0.081
  @16k:  |dQ| 0.125 -> 0.091, non-best bias -0.124 -> -0.086, |gap err| 0.096 -> 0.070
Plain search barely improves 8k->16k (allocation-bound: extra sims feed the best
arm); grading mode converts budget into cross-move accuracy. Floor-only (mode 2)
~ties on gap err, mode 1 wins the rest -> mode 1 is what ships (16k floor / 24k
ceiling in both grading flows).

Usage: uv run python solver/grade_eval.py [--positions 24] [--sims 16000]
"""
import argparse

import numpy as np

import network_wars as nw
from network_wars import (HUMAN, BOTS, make_game, check_winner, counts,
                          reinforce, run_bot_turn, resolve_battle)
import fastnw

SIM_SEED_EST = 0x12345678     # estimators share the live/default sim stream seed
SIM_SEED_TRUTH = 0xBEEFCAFE   # truth uses a different stream so errors don't correlate


def apply_action(state, action, turns):
    if action == -1:
        reinforce(state, HUMAN)
        if not check_winner(state):
            for bot in BOTS:
                run_bot_turn(state, bot)
                if check_winner(state):
                    break
        return turns + 1
    frm, to = action >> 8, action & 0xFF
    resolve_battle(state, frm, to)
    return turns


def collect_positions(n_pos, probe_sims=2000, lo=0.10, hi=0.90):
    """One live position per seed: play forward with a small normal search and take
    the first decision in turns 2+ whose best-Q is clearly undecided."""
    out = []
    seed = 0
    while len(out) < n_pos:
        seed += 1
        state = make_game(seed)
        fastnw.set_topology(state)
        turns = 1
        for _ in range(400):
            if check_winner(state) is not None or counts(state)[HUMAN] == 0:
                break
            owner, strength = fastnw.board_arrays(state)
            fastnw.use_sim(SIM_SEED_EST)
            acts, visits, q = fastnw.uct_search(owner, strength, turns,
                                                probe_sims, return_q=True)
            best = int(np.argmax(visits))
            if turns >= 2 and len(acts) > 4 and lo <= q[best] <= hi:
                out.append((seed, owner.copy(), strength.copy(),
                            [list(a) for a in state.adj], turns))
                break
            turns = apply_action(state, int(acts[best]), turns)
            if turns > nw.MAX_TURNS:
                break
    return out


def search_qs(owner, strength, turns, sims, mode, sim_seed):
    fastnw.set_grade(mode)
    fastnw.use_sim(sim_seed)
    try:
        acts, visits, q = fastnw.uct_search(owner, strength, turns, sims,
                                            return_q=True)
    finally:
        fastnw.set_grade(0)
    return {int(a): (float(qq), int(v)) for a, v, qq in zip(acts, visits, q)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--positions', type=int, default=24)
    ap.add_argument('--sims', type=int, default=16000,
                    help='estimator budget (fixed; 16000 = the shipped grading floor)')
    ap.add_argument('--truth-sims', type=int, default=200000)
    args = ap.parse_args()

    positions = collect_positions(args.positions)
    print(f'{len(positions)} live positions '
          f'(seeds {min(p[0] for p in positions)}..{max(p[0] for p in positions)})')

    # per-estimator accumulators: abs err (all / top5), signed err non-best, gap abs err
    modes = [(0, 'normal search   '), (2, 'floor only      '), (1, 'floor+2nd-half Q')]
    acc = {m: {'abs': [], 'abs5': [], 'signed_nb': [], 'gap': []} for m, _ in modes}

    for i, (seed, owner, strength, adj, turns) in enumerate(positions):
        fastnw.set_topology_csr(len(owner), adj)
        truth = search_qs(owner, strength, turns, args.truth_sims, 1, SIM_SEED_TRUTH)
        t_best_act = max(truth, key=lambda a: truth[a][0])
        top5 = sorted(truth, key=lambda a: -truth[a][0])[:5]
        for mode, _name in modes:
            est = search_qs(owner, strength, turns, args.sims, mode, SIM_SEED_EST)
            e_best_act = max(est, key=lambda a: est[a][1])   # argmax visits = the pick
            for a, (tq, _tv) in truth.items():
                if a not in est:
                    continue
                d = est[a][0] - tq
                acc[mode]['abs'].append(abs(d))
                if a in top5:
                    acc[mode]['abs5'].append(abs(d))
                if a != t_best_act:
                    acc[mode]['signed_nb'].append(d)
                    # the blunder metric: gap-to-best, est vs truth
                    g_est = est[e_best_act][0] - est[a][0]
                    g_tru = truth[t_best_act][0] - tq
                    acc[mode]['gap'].append(abs(g_est - g_tru))
        print(f'  pos {i+1}/{len(positions)} seed={seed} turn={turns} '
              f'moves={len(truth)} done')

    print(f'\nestimators @ {args.sims} sims vs truth @ {args.truth_sims} '
          f'(grade-mode, independent sim stream), {len(positions)} positions:')
    print('mode              |  mean|dQ| all  |  mean|dQ| top5 |  bias non-best |  mean|gap err|')
    for mode, name in modes:
        a = acc[mode]
        print(f'{name}  |     {np.mean(a["abs"]):.4f}     |     '
              f'{np.mean(a["abs5"]):.4f}     |    {np.mean(a["signed_nb"]):+.4f}     |     '
              f'{np.mean(a["gap"]):.4f}')


if __name__ == '__main__':
    main()
