#!/usr/bin/env python3
"""Extract single-battle observations (with SURVIVOR strengths) from iOS capture logs.

In the iOS app ONE red tap (from -> adjacent enemy) resolves exactly ONE battle.
capture_bots.py records, per applied red move, the full board AFTER the tap
(`board_after`, with per-node strengths). The board BEFORE the move is the
previous applied move's `board_after`, or the round's `board_before` for the
first move. Diffing before->after isolates a single battle and reveals:

  attacker node A (the `from`):  a = strength before
  defender node D (the `to`):    d = strength before, owner = some enemy faction
  outcome:
    CAPTURE  -> after: D.owner == red. survivor = D.strength after (attacker's
               troops that moved in and survived). A.strength after = troops left
               behind on the source node.
    REPEL    -> after: D.owner unchanged (still enemy). D.strength after = defender
               survivor; A.strength after = attacker remnant on source.

This is the ground-truth needed to fit P(capture | a, d) AND the survivor rule
(how many troops remain on win/loss), which the offline engine currently models
with iterated Bernoulli attrition at ATTACKER_WIN_P=0.60.

Usage:  python extract_battles.py [runs/botcap.jsonl ...]  > battles.csv
        python extract_battles.py --summary runs/botcap.jsonl
"""
import argparse, json, sys


def idx(board):
    return {n['id']: n for n in board}


def battles_from_game(g):
    """Yield one dict per red single-battle observation in this game record.

    Handles both log formats:
      capture_bots.py:  g['rounds_data'][*] with 'board_before' + 'red_moves'
      series.py:        g['trajectory'][*]  with 'board_before' + 'moves'
    Both record per-applied-move 'board_after' (full strengths); the pre-board of
    the first move is the round's 'board_before', and of later moves the prior
    move's 'board_after'. One applied red tap == one iOS battle.
    """
    out = []
    rounds = g.get('rounds_data')
    if rounds is not None:
        round_key, moves_key = 'rounds_data', 'red_moves'
    else:
        rounds, round_key, moves_key = g.get('trajectory', []), 'trajectory', 'moves'
    for rd in rounds:
        before = idx(rd['board_before'])
        rnd = rd.get('round')
        for mv in rd.get(moves_key, []):
            after_board = mv.get('board_after')
            if mv.get('result') != 'applied' or after_board is None:
                # not an applied single-tap with a readable after-board; skip but
                # advance `before` is impossible (no after) -> stop walking this round
                continue
            after = idx(after_board)
            fi, ti = mv['from'], mv['to']
            A0, D0 = before.get(fi), before.get(ti)
            A1, D1 = after.get(fi), after.get(ti)
            if not (A0 and D0 and A1 and D1):
                before = after
                continue
            a, d = A0.get('s'), D0.get('s')
            if a is None or d is None or D1.get('s') is None or A1.get('s') is None:
                before = after
                continue
            captured = (D0['o'] != 'red' and D1['o'] == 'red')
            repelled = (D1['o'] == D0['o'] and D0['o'] != 'red')
            if captured or repelled:
                out.append({
                    'game': g.get('game_index'), 'round': rnd,
                    'a': a, 'd': d,
                    'outcome': 'capture' if captured else 'repel',
                    'atk_survivor': D1['s'] if captured else None,  # troops that took the node
                    'src_after': A1['s'],                           # left on source node
                    'def_survivor': D1['s'] if repelled else None,  # defender remnant
                    'def_owner': D0['o'],
                })
            before = after
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='*', default=['runs/botcap.jsonl'])
    ap.add_argument('--summary', action='store_true', help='print stats instead of CSV')
    args = ap.parse_args()

    rows = []
    for p in args.paths:
        for line in open(p):
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get('type') == 'game':
                rows.extend(battles_from_game(rec))

    if not args.summary:
        cols = ['game', 'round', 'a', 'd', 'outcome', 'atk_survivor', 'src_after',
                'def_survivor', 'def_owner']
        print(','.join(cols))
        for r in rows:
            print(','.join('' if r[c] is None else str(r[c]) for c in cols))
        return

    n = len(rows)
    caps = [r for r in rows if r['outcome'] == 'capture']
    reps = [r for r in rows if r['outcome'] == 'repel']
    print(f'battle observations: {n}  (captures {len(caps)}, repels {len(reps)})')
    if not n:
        return
    print(f'overall capture rate: {len(caps)/n*100:.1f}%')
    # capture rate binned by strength ratio a/d
    from collections import defaultdict
    bins = defaultdict(lambda: [0, 0])
    for r in rows:
        ratio = r['a'] / max(1, r['d'])
        key = ('<1' if ratio < 1 else '1' if ratio == 1 else
               '1-2' if ratio < 2 else '2-3' if ratio < 3 else '3+')
        bins[key][0] += r['outcome'] == 'capture'
        bins[key][1] += 1
    print('\ncapture rate by a/d ratio:')
    for k in ['<1', '1', '1-2', '2-3', '3+']:
        c, t = bins[k]
        if t:
            print(f'  {k:>4}: {c}/{t} = {c/t*100:5.1f}%')
    # survivor signal: on capture, how does atk_survivor relate to a,d?
    print('\nCAPTURE survivors (atk troops on the taken node) — sample a,d -> survivor, src_left:')
    for r in caps[:25]:
        print(f'  a={r["a"]} d={r["d"]} -> survivor={r["atk_survivor"]} src_after={r["src_after"]}')
    print('\nREPEL survivors (defender remnant) — sample a,d -> def_survivor, src_left:')
    for r in reps[:25]:
        print(f'  a={r["a"]} d={r["d"]} -> def_survivor={r["def_survivor"]} src_after={r["src_after"]}')


if __name__ == '__main__':
    main()
