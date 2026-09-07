"""Saved-game compatibility: frozen pre-audit boards, dice, and eight bot rounds.

Run after rebuilding: uv run python solver/legacy_rules_gate.py
The digest includes topology, coordinates, ownership, armies and dice position
for 1,000 seeds. The expected value was captured from the pre-audit engine.
"""
import ctypes as c
import hashlib
from pathlib import Path
import sys


def fingerprint(path, entry="new_game_legacy"):
    lib = c.CDLL(str(Path(path).resolve()))
    ptr = c.POINTER(c.c_int)
    generate = getattr(lib, entry)
    generate.argtypes = [c.c_uint32, ptr, ptr, ptr, ptr]
    lib.get_adj.argtypes = [ptr, ptr]
    lib.get_rng_mb32.restype = c.c_uint32
    lib.end_turn.argtypes = [ptr, ptr]
    lib.ext_check_winner.argtypes = [ptr]
    result = hashlib.sha256()
    for seed in range(1, 1001):
        owner, strength, x, y = [(c.c_int * 64)() for _ in range(4)]
        off, adj = (c.c_int * 65)(), (c.c_int * 512)()
        n = generate(seed, owner, strength, x, y)
        lib.get_adj(off, adj)
        for values, size in ((x,n), (y,n), (off,n+1), (adj,off[n])):
            result.update(bytes(values)[:size*4])
        for turn in range(9):
            result.update(bytes(owner)[:n*4])
            result.update(bytes(strength)[:n*4])
            result.update(lib.get_rng_mb32().to_bytes(4, "little"))
            if turn == 8 or lib.ext_check_winner(owner) >= 0:
                break
            lib.end_turn(owner,strength)
    return result.hexdigest()


if __name__ == "__main__":
    path = Path(__file__).with_name("fast_engine.so")
    actual = fingerprint(path)
    expected = "9986e5e75e0b471cefbe95cc3134857936232793ea1719a38371ff1c4e86d945"
    assert actual == expected, f"legacy saved games drifted: {actual}"
    print("LEGACY-RULES-GATE: PASS (1,000 saved seeds and their bot rounds)")
