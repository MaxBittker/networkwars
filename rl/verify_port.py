"""JS<->Python engine parity check.

game.js and network_wars.py both model the real iOS app (the source of truth):
they share the iOS deal (every faction totals 20, 4 fixed templates) and battle
(ATTACKER_WIN_P=0.60), so this check should PASS bit-for-bit. The iOS recalibration
was ported into game.js too, restoring full parity. See memories
sim-vs-real-deal-imbalance and sim-vs-real-battle-mismatch.

Runs `node verify_dump.js` (200 games each for safeExpand and randomAll) and
replays the same seeds in Python.
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
