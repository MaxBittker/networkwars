#!/usr/bin/env python3
"""Analyze fine-grained bot-capture logs (capture_bots.py output).

For each round we have an ordered sequence of distinct boards observed during the
bot animation. Walking consecutive frames lets us:
  - attribute each owner-change to the faction that gained it,
  - check whether that capture was GREEDY-LEGAL at the prior frame (the gaining
    faction had a strictly-stronger neighbor of the captured node),
  - detect SOFTENING: a node whose strength dropped (attacked, not captured)
    between frames, later captured by a DIFFERENT faction (the cross-faction
    cascade that single-snapshot data could not distinguish from a policy break).

A capture that is greedy-illegal AND not explained by prior softening at finer
granularity is a genuine bot-policy difference from the engine's best_bot_move.

Usage: analyze_botcap.py runs/botcap.jsonl
"""
import json, sys
from collections import Counter

BOTS = ['green', 'yellow', 'blue', 'purple']


def adj_map(board):
    pos = {(n['r'], n['c']): n['id'] for n in board}
    A = {n['id']: [] for n in board}
    for n in board:
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                j = pos.get((n['r'] + dr, n['c'] + dc))
                if j is not None:
                    A[n['id']].append(j)
    return A


def idx(board):
    return {n['id']: n for n in board}


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'runs/botcap.jsonl'
    games = [json.loads(l) for l in open(path) if json.loads(l).get('type') == 'game']
    frames_per_round = []
    total_caps = 0
    legal = 0
    illegal_softened = 0       # illegal at this frame but the target was softened earlier
    illegal_genuine = 0        # illegal AND never softened -> real policy break
    softening_events = 0
    cross_faction_captures = 0
    examples = []

    for g in games:
        for rd in g.get('rounds_data', []):
            frames = rd.get('bot_frames', [])
            if not frames:
                continue
            # prepend red_post_board as frame 0 (state entering the bot phase)
            seq = [{'board': rd['red_post_board']}] + frames
            frames_per_round.append(len(frames))
            A = adj_map(seq[0]['board'])
            start = idx(seq[0]['board'])
            # track per-node strength history to detect softening before a capture
            for i in range(len(seq) - 1):
                b0 = idx(seq[i]['board'])
                b1 = idx(seq[i + 1]['board'])
                # all nodes faction F newly captured THIS step (to detect intra-turn chains:
                # a bot's multi-attack turn collapses into one frame-step, so a target may
                # only be reachable after F bridged to it via another capture this step)
                step_caps = {}
                for nid, n1 in b1.items():
                    n0 = b0.get(nid)
                    if n0 and n0['o'] != n1['o'] and n1['o'] in BOTS:
                        step_caps.setdefault(n1['o'], set()).add(nid)
                for nid, n1 in b1.items():
                    n0 = b0.get(nid)
                    if n0 is None:
                        continue
                    # softening: same owner, strength dropped (attacked, survived)
                    if n0['o'] == n1['o'] and n1['s'] is not None and n0['s'] is not None \
                            and n1['s'] < n0['s']:
                        softening_events += 1
                    # capture: owner changed to a bot faction
                    if n0['o'] != n1['o'] and n1['o'] in BOTS:
                        total_caps += 1
                        F = n1['o']
                        if n0['o'] in BOTS and n0['o'] != F:
                            cross_faction_captures += 1
                        # greedy-legal at frame i? a strictly-stronger F neighbor existed
                        Fn = [b0[j] for j in A.get(nid, []) if b0.get(j, {}).get('o') == F]
                        strong = [x for x in Fn
                                  if x['s'] is not None and n0['s'] is not None and x['s'] > n0['s']]
                        bridged = any(j in step_caps.get(F, ()) for j in A.get(nid, []))
                        start_s = start.get(nid, {}).get('s')
                        softened = (start_s is not None and n0['s'] is not None and n0['s'] < start_s)
                        if strong:
                            legal += 1
                        elif bridged or softened:
                            # explained by a cascade we can't fully resolve at this frame
                            # rate: F chained through an adjacent node it took this step,
                            # or the target was softened earlier in the round.
                            illegal_softened += 1
                        else:
                            illegal_genuine += 1
                            if len(examples) < 12:
                                examples.append(
                                    f"g{g['game_index']} r{rd['round']} f{i}->f{i+1}: "
                                    f"node{nid} {n0['o']}(s{n0['s']}) -> {F}; "
                                    f"F-nbrs={[(x['id'],x['s']) for x in Fn]} "
                                    f"step_caps[{F}]={sorted(step_caps.get(F,()))}")

    import statistics as st
    print(f"games={len(games)}  rounds-with-frames={len(frames_per_round)}")
    if frames_per_round:
        print(f"distinct bot frames/round: mean={st.mean(frames_per_round):.1f} "
              f"median={st.median(frames_per_round)} max={max(frames_per_round)}")
        print("  (>=5 means we're resolving individual faction turns; ~1 means the app "
              "animates with no static pauses and burst capture won't help)")
    print(f"\ntotal bot-captures observed across frames: {total_caps}")
    print(f"  greedy-legal (strictly-stronger F-neighbor present): {legal} "
          f"({legal/max(1,total_caps)*100:.1f}%)")
    print(f"  cascade-explained (softened earlier OR chained via own capture this step): {illegal_softened} "
          f"({illegal_softened/max(1,total_caps)*100:.1f}%)")
    print(f"  GENUINE policy break (illegal & unexplained by any cascade): {illegal_genuine} "
          f"({illegal_genuine/max(1,total_caps)*100:.1f}%)")
    print(f"\nsoftening events (strength dropped, no capture): {softening_events}")
    print(f"cross-faction captures (bot took another bot's node): {cross_faction_captures}")
    if examples:
        print("\nGENUINE-break examples (investigate these):")
        for e in examples:
            print("  " + e)


if __name__ == '__main__':
    main()
