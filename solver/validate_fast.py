"""Regression gate for the C engine (fast_engine.so).

Python is now a thin client of the C engine, so there is no longer an independent
pure-Python oracle to diff against (the old C<->Py bit-parity check). Instead this
asserts the engine's structural invariants over many seeds plus a few frozen
golden-seed game outcomes, so accidental drift in board-gen / battle / bots / deal
is caught. Run: uv run python validate_fast.py [nseeds]
"""
import sys

import numpy as np

import network_wars as nw
import fastnw

# Frozen full-game outcomes (deterministic policies). Regenerate intentionally if
# the engine is meant to change; an unexpected diff here means a behavior drift.
GOLDEN = {
    # Re-frozen 2026-07-17 for the REAL DECOMPILED bot turn (OpponentAIOriginal,
    # ipa_decompile/re/ai/): one strongest-first pass over the islands owned at
    # turn start, and after a capture the bot keeps attacking with the stack it
    # just moved (chain) until a repel or the target isn't strictly weaker. No
    # RNG in move selection (ties: node-id / adjacency order), so bot turns
    # consume dice only in battles; boards shifted vs the 07-02 freeze.
    (1, 'safe_expand'): ('blue', 7),    (1, 'random_all'): ('red', 7),
    (2, 'safe_expand'): ('green', 4),   (2, 'random_all'): ('green', 6),
    (3, 'safe_expand'): ('yellow', 6),  (3, 'random_all'): ('green', 8),
    (7, 'safe_expand'): ('yellow', 6),  (7, 'random_all'): ('yellow', 6),
    (42, 'safe_expand'): ('red', 6),    (42, 'random_all'): ('red', 5),
    (100, 'safe_expand'): ('blue', 9),  (100, 'random_all'): ('blue', 6),
}


def connected(adj, n):
    seen = {0}
    stack = [0]
    while stack:
        v = stack.pop()
        for w in adj[v]:
            if w not in seen:
                seen.add(w); stack.append(w)
    return len(seen) == n


def check_invariants(nseeds):
    fails = 0
    for seed in range(1, nseeds + 1):
        st = nw.make_game(seed)
        n = len(st.nodes)
        bad = []
        if n != nw.TARGET_NODES:
            bad.append(f"N={n}")
        # exactly 6 nodes per faction, every faction's strengths total 20 (the deal)
        per = {f: 0 for f in nw.FACTIONS}
        tot = {f: 0 for f in nw.FACTIONS}
        for nd in st.nodes:
            per[nd.owner] += 1
            tot[nd.owner] += nd.strength
        for f in nw.FACTIONS:
            if per[f] != 6:
                bad.append(f"{f} has {per[f]} nodes")
            if tot[f] != 20:
                bad.append(f"{f} totals {tot[f]} (deal != 20)")
        # adjacency symmetric + whole board connected
        for i in range(n):
            for j in st.adj[i]:
                if i not in st.adj[j]:
                    bad.append(f"asym {i}-{j}")
        if not connected(st.adj, n):
            bad.append("disconnected")
        if bad:
            fails += 1
            if fails <= 5:
                print(f"  seed {seed}: {'; '.join(bad[:5])}")
    print(f"invariants: {nseeds - fails}/{nseeds} seeds clean")
    return fails == 0


# EXACT reference for the REAL decompiled battle (iterated fair coins, keep-1;
# see REAL_BATTLE_DECOMPILED.md). No fitted parameters — these are the closed-form
# DP moments of the actual loop, so the gate checks the engine against ground truth.
from functools import lru_cache

@lru_cache(None)
def _cp(a, d):                 # main-loop P(capture) from (a,d)
    if d <= 0: return 1.0 if a > 1 else 0.0
    if a <= 1: return 0.0
    return (_cp(a-1, d-1) + _cp(a, d-1) + _cp(a-1, d)) / 3.0

@lru_cache(None)
def _cs(a, d, k):              # main-loop E[occupier^k * 1{capture}] (occupier=final a-1)
    if d <= 0: return float((a-1) ** k) if a > 1 else 0.0
    if a <= 1: return 0.0
    return (_cs(a-1, d-1, k) + _cs(a, d-1, k) + _cs(a-1, d, k)) / 3.0

@lru_cache(None)
def _rs(a, d, k):             # main-loop E[remnant^k * 1{repel}] (remnant=final d)
    if d <= 0: return 0.0     # d==0 is a capture (a>1) or (1,0) repel with rem 0
    if a <= 1: return float(d ** k)
    return (_rs(a-1, d-1, k) + _rs(a, d-1, k) + _rs(a-1, d, k)) / 3.0

def _prefire(a, d, fn):       # fold the two guarded attacker pre-fires on d (a fixed)
    tot = 0.0
    for c1 in (0, 1):
        for c2 in (0, 1):
            dd = d
            if dd > 0 and c1: dd -= 1
            if dd > 0 and c2: dd -= 1
            tot += 0.25 * fn(a, dd)
    return tot

def pcap(a, d):     return _prefire(a, d, _cp)                     # P(capture)
def mean_occ(a, d):                                               # E[occupier | capture]
    p = pcap(a, d);  return _prefire(a, d, lambda A, D: _cs(A, D, 1)) / p if p > 0 else 0.0
def mean_rem(a, d):                                              # E[remnant | repel]
    pr = 1.0 - pcap(a, d);  return _prefire(a, d, lambda A, D: _rs(A, D, 1)) / pr if pr > 0 else 0.0
def var_occ(a, d):
    p = pcap(a, d)
    if p <= 0: return 0.0
    m = mean_occ(a, d);  return max(0.0, _prefire(a, d, lambda A, D: _cs(A, D, 2)) / p - m * m)
def var_rem(a, d):
    pr = 1.0 - pcap(a, d)
    if pr <= 0: return 0.0
    m = mean_rem(a, d);  return max(0.0, _prefire(a, d, lambda A, D: _rs(A, D, 2)) / pr - m * m)

def check_battle_invariants():
    """Survivors are drawn around the fitted mean (occupier = beta-binomial with
    overdispersion rho, remnant = binomial). Per (a,d) assert:
      - source node always gutted to 1;
      - capture => occupier in [1, a-1]; repel => defender remnant in [0, d];
      - empirical MEAN matches mean_occ / mean_rem;
      - empirical VARIANCE matches the (beta-)binomial var (this is what
        distinguishes the overdispersed occupier from a plain binomial).
    Determinism (per seed) is covered by the golden games below."""
    import numpy as np
    fastnw.set_topology_csr(2, [[1], [0]])
    TRIALS = 4000
    fails = 0

    def mean_ok(vals, target, label):
        """|empirical - target| within max(0.08, 4*SE): catches systematic bias
        (many sigma) but tolerates Monte-Carlo wobble on rare-outcome cells."""
        nonlocal fails
        if len(vals) < 150:
            return
        se = np.std(vals) / len(vals) ** 0.5
        if abs(np.mean(vals) - target) > max(0.08, 4 * se):
            fails += 1
            print(f"  {label}: {np.mean(vals):.3f} vs {target:.3f}  (n={len(vals)})")

    def var_ok(vals, target, label):
        """empirical variance vs predicted, with a relative + SE-aware tolerance
        (variance has ~sqrt(2/n) relative noise)."""
        nonlocal fails
        if len(vals) < 400 or target < 0.05:
            return
        ev = np.var(vals)
        tol = max(0.04, 0.18 * target, 4 * target * (2 / len(vals)) ** 0.5)
        if abs(ev - target) > tol:
            fails += 1
            print(f"  {label}: var {ev:.3f} vs {target:.3f}  (n={len(vals)})")

    def cap_ok(ncap, ntot, a0, d0):
        """empirical capture rate vs the exact DP P(capture), SE-aware."""
        nonlocal fails
        if ntot < 150:
            return
        emp = ncap / ntot
        target = pcap(a0, d0)
        se = (max(target * (1 - target), 1e-6) / ntot) ** 0.5
        if abs(emp - target) > max(0.03, 4 * se):
            fails += 1
            print(f"  cap rate a0={a0} d0={d0}: {emp:.3f} vs {target:.3f}  (n={ntot})")

    for a0 in range(2, 12):
        for d0 in range(1, 12):
            occ, rem = [], []
            ncap = 0
            for k in range(TRIALS):
                owner = np.array([0, 1], dtype=np.int32)
                strength = np.array([a0, d0], dtype=np.int32)
                fastnw.use_sim(0x1234 + a0 * 131 + d0 * 7 + k)
                _, meta = fastnw.attack_logged(owner, strength, 0, 1)
                bad = (strength[0] != 1)
                if meta['captured']:
                    ncap += 1
                    bad |= (owner[1] != 0 or not (1 <= strength[1] <= a0 - 1))
                    occ.append(int(strength[1]))
                else:
                    bad |= (owner[1] != 1 or not (0 <= strength[1] <= d0))
                    rem.append(int(strength[1]))
                if bad:
                    fails += 1
                    if fails <= 5:
                        print(f"  battle a0={a0} d0={d0}: cap={meta['captured']} "
                              f"-> own={list(owner)} str={list(strength)}")
            cap_ok(ncap, TRIALS, a0, d0)
            mean_ok(occ, mean_occ(a0, d0), f"occ mean a0={a0} d0={d0}")
            mean_ok(rem, mean_rem(a0, d0), f"rem mean a0={a0} d0={d0}")
            var_ok(occ, var_occ(a0, d0), f"occ var  a0={a0} d0={d0}")
            var_ok(rem, var_rem(a0, d0), f"rem var  a0={a0} d0={d0}")
    print(f"battle invariants: {'PASS' if fails == 0 else f'{fails} FAIL'} "
          f"(range + mean + variance over {TRIALS}/cell)")
    return fails == 0


def check_golden():
    fails = 0
    for (seed, pol), expect in GOLDEN.items():
        r = nw.play_game(getattr(nw, pol), seed)
        got = (r['winner'], r['turns'])
        if got != expect:
            fails += 1
            print(f"  golden seed={seed} {pol}: got {got} expected {expect}")
    print(f"golden games: {len(GOLDEN) - fails}/{len(GOLDEN)} match")
    return fails == 0


def check_grade():
    """Grading mode (uct_set_grade) contract: OFF is the default and the flag is
    resettable (a plain search after grade(1)+reset is bit-identical to one that
    never graded), and ON floors every root child's visits at ~35% of the uniform
    share so cross-move Qs are comparable (blunder analysis; see grade_eval.py)."""
    state = nw.make_game(42)
    fastnw.set_topology(state)
    owner, strength = fastnw.board_arrays(state)

    def run():
        fastnw.use_sim(0x12345678)
        return fastnw.uct_search(owner, strength, 1, 8000, return_q=True)

    a0, v0, q0 = run()
    fastnw.set_grade(1)
    a1, v1, q1 = run()
    fastnw.set_grade(0)
    a2, v2, q2 = run()
    ok = True
    floor = int(0.35 * 8000 / len(a1)) - 2      # small slack: floor tracks a growing total
    if v1.min() < floor:
        ok = False
        print(f"  grade floor violated: min root visits {v1.min()} < {floor}")
    if not (np.array_equal(a0, a2) and np.array_equal(v0, v2) and np.array_equal(q0, q2)):
        ok = False
        print("  grade reset broken: plain search after grade(1)+grade(0) drifted")
    if np.array_equal(v0, v1):
        ok = False
        print("  grade mode had no effect on root allocation")
    print(f"grade mode: {'PASS' if ok else 'FAIL'} "
          f"(root floor >= {floor} visits, reset bit-identical)")
    return ok


def check_sweep():
    """The web sweep-up's mop-up policy + certificate (sweep_best_move /
    sweep_certify). The certificate is what authorizes the UI to finish a game for
    the player, so pin its contract: it never certifies an opening, it does certify
    an already-won position, it leaves the REAL dice stream untouched (it must roll
    on the private sim stream — otherwise merely OFFERING a sweep would change the
    game's dice), and the move it plays is legal + strictly-stronger-attacker."""
    ok = True
    fastnw.set_grade(0)
    for seed in (1, 2, 3, 42, 99):
        state = nw.make_game(seed)
        fastnw.set_topology(state)
        owner, strength = fastnw.board_arrays(state)
        mb0 = fastnw.get_mb32()
        if fastnw.sweep_certify(owner, strength, 1, 200) == 0:
            ok = False
            print(f"  seed {seed}: opening certified as a won mop-up (200 clean playouts)")
        if fastnw.get_mb32() != mb0:
            ok = False
            print(f"  seed {seed}: certificate consumed the REAL dice stream")
        mv = fastnw.sweep_best_move(owner, strength)
        if mv is not None:
            frm, to = mv
            if not (owner[frm] == 0 and owner[to] != 0 and strength[frm] > strength[to]
                    and to in state.adj[frm]):
                ok = False
                print(f"  seed {seed}: sweep move {mv} illegal or not strictly stronger")
    # positive control: RED owns everything but one node -> every mop-up wins
    state = nw.make_game(7)
    fastnw.set_topology(state)
    owner, strength = fastnw.board_arrays(state)
    owner[:] = 0
    strength[:] = 3
    owner[-1] = 1
    strength[-1] = 1
    if fastnw.sweep_certify(owner, strength, 1, 200) != 0:
        ok = False
        print("  a 29-of-30-nodes RED position failed to certify")
    # negative control: a STALEMATE must fail the certificate. Equal strengths on
    # this split -> mutual borders reinforce in lockstep, nobody (mop-up or bots)
    # ever sees a strictly weaker target, the game never terminates — and RED holds
    # a strict plurality (18 vs 12), which is the exact old-bug path: the stalled
    # playout used to score as a red win by plurality, so the cert kept passing and
    # the live sweep end-turned forever. A stalled playout must count as a LOSS.
    state = nw.make_game(15)
    fastnw.set_topology(state)
    owner, strength = fastnw.board_arrays(state)
    owner[:18] = 0
    owner[18:] = 1
    strength[:] = 5
    if fastnw.sweep_certify(owner, strength, 1, 200) == 0:
        ok = False
        print("  a stalemate certified as a won mop-up (sweep would end-turn forever)")
    print(f"sweep certificate: {'PASS' if ok else 'FAIL'} "
          f"(openings rejected, won position accepted, stalemate rejected, "
          f"real dice untouched)")
    return ok


def main():
    nseeds = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    ok = check_invariants(nseeds) & check_battle_invariants() & check_golden() \
        & check_grade() & check_sweep()
    print("RESULT:", "ALL CHECKS PASS" if ok else "FAILURES")
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
