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
    # Re-frozen 2026-06-23 for the single-shot power-ratio battle (G=3.40, C=1.26)
    # + attacker-strength-first bot with random tie-breaks (deterministic per seed).
    (1, 'safe_expand'): ('purple', 9),  (1, 'random_all'): ('green', 8),
    (2, 'safe_expand'): ('green', 7),   (2, 'random_all'): ('green', 4),
    (3, 'safe_expand'): ('green', 9),   (3, 'random_all'): ('purple', 8),
    (7, 'safe_expand'): ('yellow', 7),  (7, 'random_all'): ('purple', 6),
    (42, 'safe_expand'): ('red', 8),    (42, 'random_all'): ('purple', 7),
    (100, 'safe_expand'): ('blue', 10), (100, 'random_all'): ('yellow', 7),
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


def check_battle_invariants():
    """capture => occupier left behind (to>=1, from==1); repel => from==1,
    to==max(0,d0-a0+1). Holds for every outcome, so run a spread of (a,d)."""
    import numpy as np
    fastnw.set_topology_csr(2, [[1], [0]])
    fails = 0
    trials = 0
    for a0 in range(1, 12):
        for d0 in range(1, 12):
            for k in range(6):
                owner = np.array([0, 1], dtype=np.int32)
                strength = np.array([a0, d0], dtype=np.int32)
                fastnw.use_sim(0x1234 + a0 * 131 + d0 * 7 + k)
                _, meta = fastnw.attack_logged(owner, strength, 0, 1)
                trials += 1
                if meta['captured']:
                    ok = owner[1] == 0 and strength[1] >= 1 and strength[0] == 1
                else:
                    ok = (owner[1] == 1 and strength[0] == 1
                          and strength[1] == max(0, d0 - a0 + 1))
                if not ok:
                    fails += 1
                    if fails <= 5:
                        print(f"  battle a0={a0} d0={d0}: cap={meta['captured']} "
                              f"-> own={list(owner)} str={list(strength)}")
    print(f"battle invariants: {trials - fails}/{trials} ok")
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
