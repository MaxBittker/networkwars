#!/usr/bin/env python3
"""Are the REAL iOS bots stronger than our best_bot_move model?

For each live round we know the board AFTER red's attacks (red_post = last applied
move's board_after) and the board at the START of the next round (= after the real
bot phase). We replay the SIM bot phase from red_post many times (reinforce(red) +
run_bot_turn for each bot, using the CORRECTED battle so only bot POLICY differs)
and compare the distribution of red's resulting node count to what REALLY happened.

If the real next-round red count is systematically BELOW the sim distribution, the
real bots take more of red's nodes than best_bot_move -> they are stronger, which
would explain live ~80% vs offline ~91-96%.

Usage: python bot_strength_test.py [--ksim 200] [--max-round 4]
"""
import argparse, copy, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import network_wars as nw
from network_wars import HUMAN, FACTIONS
import nwmove_fast as NWM

K, C0 = 0.62, 0.93
BOTS = [f for f in FACTIONS if f != HUMAN]


def corrected_resolve_battle(state, from_id, to_id):
    frm = state.nodes[from_id]; to = state.nodes[to_id]
    a = frm.strength; d = to.strength; rng = state.rng
    a0, d0 = a, d
    while a > 1 and d > 0:
        q = a ** K / (a ** K + C0 * d ** K)
        if rng() < q: d -= 1
        else: a -= 1
    if d == 0 and a >= 2:
        to.owner = frm.owner; to.strength = a - 1; frm.strength = 1
        return True
    frm.strength = 1; to.strength = max(0, d0 - a0 + 1)
    return False


# Bots run in C now, so monkeypatching nw.resolve_battle is a no-op; replay the bot
# turn in pure Python with the baseline policy + the corrected battle above.
def run_bot_turn(state, faction):
    if nw.counts(state)[faction] == 0:
        return
    g = 0
    while g < 1000:
        g += 1
        mv = nw.best_bot_move(state, faction)
        if mv is None:
            break
        corrected_resolve_battle(state, mv[0], mv[1])
        if nw.check_winner(state) is not None:
            return
    nw.reinforce(state, faction)


def mulberry(seed):
    s = seed & 0xFFFFFFFF
    def rng():
        nonlocal s
        s = (s + 0x6D2B79F5) & 0xFFFFFFFF
        t = s
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return (((t ^ (t >> 14)) & 0xFFFFFFFF)) / 4294967296.0
    return rng


def red_count(state):
    return sum(1 for n in state.nodes if n.owner == HUMAN)


def sim_bot_phase(board_js, ksim):
    """Return list of red node counts after ksim simulated bot phases from this board."""
    out = []
    for k in range(ksim):
        st = NWM.build_state(board_js)
        st.rng = mulberry(0x9E3779B9 ^ (k * 2654435761))
        nw.reinforce(st, HUMAN)
        for b in BOTS:
            run_bot_turn(st, b)
        out.append(red_count(st))
    return out


def board_from_move_or_turn(turn):
    """red_post board (with strengths) = last applied move's board_after, else turn board_before."""
    last = None
    for m in turn.get('moves', []):
        if m.get('result') == 'applied' and m.get('board_after'):
            last = m['board_after']
    if last is None:
        last = turn.get('board_before')
    if last is None:
        return None
    # build the parsed-board JSON shape build_state expects: id,row,col,owner,strength
    return {'nodes': [{'id': n['id'], 'row': n['r'], 'col': n['c'],
                       'owner': n['o'], 'strength': n['s'] if n['s'] is not None else 1}
                      for n in last]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ksim', type=int, default=200)
    ap.add_argument('--max-round', type=int, default=4)
    ap.add_argument('files', nargs='*', default=[
        'runs/series_20260621_battle.jsonl', 'runs/series_20260622_prsearch.jsonl'])
    args = ap.parse_args()

    import statistics as st
    rows = []  # (round, actual_red, sim_mean, pctile_of_actual)
    for f in args.files:
        for line in open(f):
            r = json.loads(line)
            if r.get('type') != 'game':
                continue
            traj = r.get('trajectory', [])
            for i in range(len(traj) - 1):
                rnd = traj[i].get('round')
                if rnd is None or rnd > args.max_round:
                    continue
                board = board_from_move_or_turn(traj[i])
                if board is None or len(board['nodes']) != 30:
                    continue
                nxt = traj[i + 1].get('counts_before', {})
                actual = nxt.get('red')
                if actual is None:
                    continue
                sims = sim_bot_phase(board, args.ksim)
                m = st.mean(sims)
                # percentile of actual within the sim distribution
                pct = sum(1 for s in sims if s <= actual) / len(sims)
                rows.append((rnd, actual, m, pct, r['result']))

    print(f"replayed {len(rows)} live round-transitions (rounds 0-{args.max_round}), "
          f"ksim={args.ksim}, corrected battle")
    # aggregate: how does ACTUAL red survival compare to SIM-predicted?
    diffs = [a - m for _, a, m, _, _ in rows]
    print(f"\nactual_red - sim_mean_red:  mean={st.mean(diffs):+.2f}  median={st.median(diffs):+.1f}")
    print("  (negative => REAL bots leave red FEWER nodes than best_bot_move sim => real bots stronger)")
    below = sum(1 for d in diffs if d < -0.5)
    above = sum(1 for d in diffs if d > 0.5)
    print(f"  real worse-for-red than sim: {below}/{len(rows)} ({below/len(rows)*100:.0f}%); "
          f"better-for-red: {above}/{len(rows)} ({above/len(rows)*100:.0f}%)")
    # by round
    print("\nby round:  n   actual_red  sim_red  diff")
    for rr in range(args.max_round + 1):
        sub = [(a, m) for rnd, a, m, _, _ in rows if rnd == rr]
        if sub:
            am = st.mean(a for a, _ in sub); sm = st.mean(m for _, m in sub)
            print(f"  r{rr}: {len(sub):4d}   {am:6.2f}    {sm:6.2f}   {am-sm:+.2f}")
    # split by game outcome
    for res in ('loss', 'win'):
        sub = [a - m for _, a, m, _, rr in rows if rr == res]
        if sub:
            print(f"\n{res} games: actual-sim mean={st.mean(sub):+.2f} (n={len(sub)})")


if __name__ == '__main__':
    main()
