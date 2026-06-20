"""Validate fast_engine.so against network_wars.py for bit-exact rule parity.

Both engines are driven by the SAME mulberry32 stream (seeded identically), so if
any rule or RNG-consumption order diverges, results desync and mismatch. We check
primitives (battle, reinforce, bot turn) and full greedy playouts.
"""
import sys
import numpy as np

import network_wars as nw
from network_wars import make_game, make_rng, resolve_battle, reinforce, run_bot_turn, check_winner, counts
import fastnw


def py_state_from(board_owner, board_strength, ref, rng):
    """Build a Python state with given owner/strength arrays, sharing topology of ref."""
    s = nw.State()
    s.nodes = [nw.Node(n.id, n.x, n.y, nw.FACTIONS[board_owner[n.id]], int(board_strength[n.id]))
               for n in ref.nodes]
    s.adj = ref.adj
    s.links = ref.links
    s.rng = rng
    s.policy_rng = rng
    return s


def boards_match(state, owner, strength):
    for nd in state.nodes:
        if fastnw.FIDX[nd.owner] != owner[nd.id] or nd.strength != strength[nd.id]:
            return False
    return True


def main():
    nseeds = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    rng_seed_base = 0xABCDEF

    n_prim = 0
    fail_prim = 0
    fail_roll = 0
    roll_agree = 0
    roll_total = 0

    fastnw.set_red_rollout_policy(0)   # greedy, to match Python rollout_to_terminal
    for seed in range(1, nseeds + 1):
        ref = make_game(seed)
        fastnw.set_topology(ref)
        owner0, strength0 = fastnw.board_arrays(ref)

        # ---- primitive: full run_bot_turn for each faction under shared rng ----
        for faction in range(0, 5):
            vseed = (rng_seed_base + seed * 31 + faction) & nw.M32
            # python
            py = py_state_from(owner0, strength0, ref, make_rng(vseed))
            run_bot_turn(py, nw.FACTIONS[faction])
            # C
            o = owner0.copy(); st = strength0.copy()
            fastnw.use_mb32(vseed)
            fastnw._lib.ext_run_bot_turn(fastnw._p(o), fastnw._p(st), faction)
            n_prim += 1
            if not boards_match(py, o, st):
                fail_prim += 1
                if fail_prim <= 3:
                    print(f"  PRIM MISMATCH seed={seed} faction={faction}")
                    print("   py owner:", [fastnw.FIDX[n.owner] for n in py.nodes])
                    print("   C  owner:", list(o))
                    print("   py str  :", [n.strength for n in py.nodes])
                    print("   C  str  :", list(st))

        # ---- full greedy playout parity (RED plays bot-style), shared rng ----
        for k in range(3):
            vseed = (rng_seed_base * 7 + seed * 101 + k) & nw.M32
            # python rollout_to_terminal expects a state w/ .rng
            from mcts import rollout_to_terminal
            py = py_state_from(owner0, strength0, ref, make_rng(vseed))
            py_res = rollout_to_terminal(py, 1)
            o = owner0.copy(); st = strength0.copy()
            fastnw.use_mb32(vseed)
            c_res = fastnw.rollout(o, st, 1)
            roll_total += 1
            if int(py_res) == int(c_res):
                roll_agree += 1
            else:
                fail_roll += 1
                if fail_roll <= 3:
                    print(f"  ROLLOUT MISMATCH seed={seed} k={k}: py={py_res} C={c_res}")

    print(f"\nprimitive run_bot_turn parity: {n_prim - fail_prim}/{n_prim} exact")
    print(f"full playout parity (shared rng): {roll_agree}/{roll_total} agree")
    ok = (fail_prim == 0 and fail_roll == 0)
    print("RESULT:", "ALL PARITY CHECKS PASS" if ok else "PARITY FAILURES")
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
