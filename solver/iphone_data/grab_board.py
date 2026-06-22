#!/usr/bin/env python3
"""Capture the CURRENT iOS phone board and write it as JSON for play_sim.html to import.

Run while iPhone Mirroring is live (lock the phone if it shows "iPhone in Use").
Writes imported_board.json and also prints the one-line JSON. In play_sim.html click
"Import board file" and choose imported_board.json (or paste the printed JSON). You can
then play the sim bots from that exact iOS position and compare behavior side by side.

Usage:  python grab_board.py
"""
import json
import os

import play as PL

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'imported_board.json')


def main():
    PL.place()
    st, fp = PL.capture_state('grab_board', max_tries=25)
    if fp is None or st in ('over', None):
        print('No clean board parse. Lock the phone if it says "iPhone in Use", then retry.')
        return
    nodes = [{'id': n['id'], 'x': n['col'], 'y': n['row'],
              'owner': n['owner'], 'strength': n['strength']} for n in st['nodes']]
    miss = [n for n in nodes if n['strength'] is None]
    board = {'nodes': nodes, 'counts': dict(st['counts'])}
    with open(OUT, 'w') as f:
        f.write(json.dumps(board))
    warn = f"  WARNING: {len(miss)} nodes had unreadable strength (will default to 1)" if miss else ""
    print(f"wrote {OUT}  ({len(nodes)} nodes, counts={dict(st['counts'])}){warn}")
    print("In play_sim.html: 'Import board file' -> choose imported_board.json "
          "(or paste the JSON line below).")
    print(json.dumps(board))


if __name__ == '__main__':
    main()
