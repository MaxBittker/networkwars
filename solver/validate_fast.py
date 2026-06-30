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
    # Re-frozen 2026-06-30 for the BETA-BINOMIAL occupier (occ = 1 + BetaBinom(a-2,
    # p_occ, rho=0.21) via Pólya urn; remnant stays Binom(d, p_rem); means = the §7
    # occupier plane / remnant hinge; BATTLE_FUNCTION.md §8) on top of the single-shot
    # power-ratio battle (G=3.40, C=1.26) + attacker-strength-first bot. The urn uses
    # the same n RNG draws as the binomial but different thresholds, so survivor values
    # shifted the boards vs the 06-29 freeze; still fully reproducible per seed.
    (1, 'safe_expand'): ('purple', 15), (1, 'random_all'): ('purple', 7),
    (2, 'safe_expand'): ('blue', 9),    (2, 'random_all'): ('green', 5),
    (3, 'safe_expand'): ('green', 7),   (3, 'random_all'): ('green', 6),
    (7, 'safe_expand'): ('yellow', 6),  (7, 'random_all'): ('yellow', 6),
    (42, 'safe_expand'): ('purple', 13), (42, 'random_all'): ('purple', 9),
    (100, 'safe_expand'): ('purple', 5), (100, 'random_all'): ('red', 9),
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

OCC_RHO = 0.21         # capture-occupier overdispersion (BATTLE_FUNCTION §8)

def var_occ(a, d):     # Var[occupier] — beta-binomial: binomial * (1 + (n-1)*rho)
    n = a - 2
    if n <= 0:
        return 0.0
    p = min(1.0, max(0.0, (mean_occ(a, d) - 1.0) / n))
    return n * p * (1 - p) * (1 + (n - 1) * OCC_RHO)

def var_rem(a, d):     # Var[remnant] — plain binomial
    if d <= 0:
        return 0.0
    p = min(1.0, max(0.0, mean_rem(a, d) / d))
    return d * p * (1 - p)

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


def main():
    nseeds = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    ok = check_invariants(nseeds) & check_battle_invariants() & check_golden()
    print("RESULT:", "ALL CHECKS PASS" if ok else "FAILURES")
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
