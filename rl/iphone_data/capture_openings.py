#!/usr/bin/env python3
"""Batch-collect fresh opening boards from the real app for structural auditing.
Loop: capture+parse the opening, save it, then Surrender -> New Game, repeat.
Requires iPhone Mirroring connected with a Network Wars game on screen.

Usage: capture_openings.py [N]   (default 15)
"""
import os, sys, json, time, subprocess
import play as PL   # reuse capture_state / tap / sh / NWCAP / CAP

N = int(sys.argv[1]) if len(sys.argv) > 1 else 15
SURRENDER = (41, 643)
NEW_GAME = (236, 416)   # "New Game" in the surrender-confirm modal

PL.sh('bash', PL.NWCAP, 'place')
saved = 0
for i in range(N):
    st, fp = PL.capture_state(f'opening_{i:02d}')
    if st == 'over' or fp is None:
        print(f"[{i}] could not get a clean board; stopping."); break
    c = st['counts']
    if sum(c.values()) == 30 and all(v == 6 for v in c.values()):
        print(f"[{i}] opening OK  strengths={sorted(n['strength'] for n in st['nodes'])}")
        saved += 1
    else:
        print(f"[{i}] not a 6/6/6/6/6 opening (counts={c}); saved anyway")
    # next game: Surrender -> New Game
    PL.tap(*SURRENDER); time.sleep(1.2)
    PL.tap(*NEW_GAME); time.sleep(3.0)

print(f"\nSaved {saved} clean openings to {PL.CAP}/opening_*.json")
