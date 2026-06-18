"""Verify the Python engine port against the JS engine.

Runs `node verify_dump.js` (200 games each for safeExpand and randomAll) and
replays the same seeds in Python. Every game must end with the same winner,
turn count, and final node counts — this exercises the RNG, board generation,
battle resolution, reinforcements, and all four bots end to end.
"""

import json
import subprocess
import sys
from pathlib import Path

import network_wars as nw

HERE = Path(__file__).parent
js = json.loads(subprocess.check_output(['node', str(HERE / 'verify_dump.js')]))

POLICIES = {'safeExpand': nw.safe_expand, 'randomAll': nw.random_all}

bad = 0
for name, policy in POLICIES.items():
    for rec in js[name]:
        py = nw.play_game(policy, rec['seed'])
        ok = (py['winner'] == rec['winner'] and py['turns'] == rec['turns']
              and py['counts'] == rec['counts'])
        if not ok:
            bad += 1
            print(f"MISMATCH {name} seed={rec['seed']}\n  js: {rec}\n  py: {py}")

total = sum(len(v) for v in js.values())
if bad:
    print(f'\n{bad}/{total} games mismatched')
    sys.exit(1)
print(f'all {total} games match (winner, turns, counts) between JS and Python engines')
