#!/usr/bin/env python3
"""Structural audit of board layouts: missing-node count, bounding box, connectivity,
and per-cell missing-frequency heatmap. Compares real captures vs engine output.

Usage:
  node -e '...dump engine boards...' > /tmp/engine_occ.json   # [[ [x,y],... ], ...]
  audit_boards.py captures/start_*.json captures/opening_*.json
"""
import sys, json, glob
from collections import Counter


def occ_from_json(path):
    s = json.load(open(path))
    if sum(s['counts'].values()) != 30:
        return None
    return {(n['row'], n['col']) for n in s['nodes']}


def connected(o):
    seen = {next(iter(o))}; stack = list(seen)
    while stack:
        r, c = stack.pop()
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if (dr or dc) and (r+dr, c+dc) in o and (r+dr, c+dc) not in seen:
                    seen.add((r+dr, c+dc)); stack.append((r+dr, c+dc))
    return len(seen) == len(o)


def audit(name, boards):
    bbox, miss = Counter(), Counter()
    heat = Counter(); conn = 0
    for o in boards:
        rows = [r for r, c in o]; cols = [c for r, c in o]
        nc, nr = max(cols)+1, max(rows)+1
        bbox[(nc, nr)] += 1
        miss[nc*nr - len(o)] += 1
        conn += connected(o)
        if (nc, nr) == (6, 7):
            for r in range(7):
                for c in range(6):
                    if (r, c) not in o:
                        heat[(r, c)] += 1
    n = len(boards)
    print(f"=== {name}  (n={n}) ===")
    print("  bbox dims     :", dict(bbox))
    print("  missing count :", dict(sorted(miss.items())))
    print("  connected     :", f"{conn}/{n}")
    if heat:
        print("  missing-freq heatmap (% of boards each cell is a hole):")
        for r in range(7):
            print("    " + " ".join(f"{100*heat[(r,c)]/n:4.0f}" for c in range(6)))
    print()


if __name__ == '__main__':
    files = []
    for a in sys.argv[1:]:
        files += glob.glob(a)
    real = [o for f in files if (o := occ_from_json(f))]
    if real:
        audit("REAL captures", real)
    try:
        eng = [{(r, c) for c, r in b} for b in json.load(open('/tmp/engine_occ.json'))]
        audit("ENGINE", eng)
    except FileNotFoundError:
        print("(no /tmp/engine_occ.json — dump engine boards to compare)")
