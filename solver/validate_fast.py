"""Regression gate for the C engine (fast_engine.so).

Python is now a thin client of the C engine, so there is no longer an independent
pure-Python oracle to diff against (the old C<->Py bit-parity check). Instead this
asserts the engine's structural invariants over many seeds plus a few frozen
golden-seed game outcomes, so accidental drift in board-gen / battle / bots / deal
is caught. Run: uv run python validate_fast.py [nseeds]
"""
import sys

import network_wars as nw
import fastnw

# Frozen full-game outcomes (deterministic policies). Regenerate intentionally if
# the engine is meant to change; an unexpected diff here means a behavior drift.
GOLDEN = {
    # Re-frozen 2026-06-29 for BINOMIAL survivors (occupier 1+Binom(a-2,p_occ),
    # remnant Binom(d,p_rem) with means = the fitted occupier plane / remnant hinge;
    # BATTLE_FUNCTION.md §7) on top of the single-shot power-ratio battle (G=3.40,
    # C=1.26) + attacker-strength-first bot. Survivor draws consume the seeded mb32
    # stream, so outcomes shifted vs the deterministic-survivor freeze but stay
    # fully reproducible per seed.
    (1, 'safe_expand'): ('yellow', 10), (1, 'random_all'): ('yellow', 12),
    (2, 'safe_expand'): ('green', 8),   (2, 'random_all'): ('green', 6),
    (3, 'safe_expand'): ('green', 5),   (3, 'random_all'): ('green', 6),
    (7, 'safe_expand'): ('green', 7),   (7, 'random_all'): ('yellow', 8),
    (42, 'safe_expand'): ('red', 5),    (42, 'random_all'): ('purple', 19),
    (100, 'safe_expand'): ('purple', 6), (100, 'random_all'): ('green', 10),
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


def mean_occ(a, d):    # E[occupier | capture], clipped to [1, a-1] (BATTLE_FUNCTION §7)
    return min(a - 1, max(1.0, 0.82 * a - 0.44 * d + 0.10))

def mean_rem(a, d):    # E[remnant | repel] — hinge, clipped to [0, d] (BATTLE_FUNCTION §7)
    return min(float(d), max(0.0, 0.30 + 0.24 * d + 0.42 * max(0, d - a)))

def check_battle_invariants():
    """Survivors are now BINOMIAL around the fitted mean. Per (a,d) assert:
      - source node always gutted to 1;
      - capture => occupier in [1, a-1]; repel => defender remnant in [0, d];
      - the empirical mean survivor over many draws matches mean_occ / mean_rem.
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

    for a0 in range(2, 12):
        for d0 in range(1, 12):
            occ, rem = [], []
            for k in range(TRIALS):
                owner = np.array([0, 1], dtype=np.int32)
                strength = np.array([a0, d0], dtype=np.int32)
                fastnw.use_sim(0x1234 + a0 * 131 + d0 * 7 + k)
                _, meta = fastnw.attack_logged(owner, strength, 0, 1)
                bad = (strength[0] != 1)
                if meta['captured']:
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
            mean_ok(occ, mean_occ(a0, d0), f"occ mean a0={a0} d0={d0}")
            mean_ok(rem, mean_rem(a0, d0), f"rem mean a0={a0} d0={d0}")
    print(f"battle invariants: {'PASS' if fails == 0 else f'{fails} FAIL'} "
          f"(range + empirical-mean over {TRIALS}/cell)")
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


def main():
    nseeds = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    ok = check_invariants(nseeds) & check_battle_invariants() & check_golden()
    print("RESULT:", "ALL CHECKS PASS" if ok else "FAILURES")
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
