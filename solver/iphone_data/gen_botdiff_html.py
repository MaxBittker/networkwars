#!/usr/bin/env python3
"""Render the most DIVERGENT live bot-phase transitions as side-by-side board images.

For each early-round transition we show three 6x7 boards:
  BEFORE      = red_post (board after red's attacks, before End Turn / bot phase)
  REAL AFTER  = the actual next-round board (after the REAL game's reinforce + bots)
  SIM AFTER   = our engine's reinforce(red) + run_bot_turn(all bots) from the same BEFORE
Cases are ranked by how much WORSE the real outcome was for red than our sim predicts
(actual red nodes << sim-mean red nodes), i.e. where reality punishes red harder than
our model. Red nodes that flipped to a bot in REAL but NOT in the shown SIM run are ringed.

Output: botdiff.html
"""
import argparse, json, os, sys, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import network_wars as nw
from network_wars import HUMAN, FACTIONS
import nwmove_fast as NWM

K, C0 = 0.62, 0.93
BOTS = [f for f in FACTIONS if f != HUMAN]
COLORS = {'red': '#e74c3c', 'green': '#27ae60', 'yellow': '#f1c40f',
          'blue': '#3498db', 'purple': '#9b59b6'}


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


def board_js(turn):
    last = None
    for m in turn.get('moves', []):
        if m.get('result') == 'applied' and m.get('board_after'):
            last = m['board_after']
    if last is None:
        last = turn.get('board_before')
    if last is None:
        return None
    return {'nodes': [{'id': n['id'], 'row': n['r'], 'col': n['c'],
                       'owner': n['o'], 'strength': n['s'] if n['s'] is not None else 1}
                      for n in last]}


def sim_once(board, seed):
    st_ = NWM.build_state(board)
    st_.rng = mulberry(seed)
    nw.reinforce(st_, HUMAN)
    for b in BOTS:
        run_bot_turn(st_, b)
    return {n.id: (n.owner, n.strength) for n in st_.nodes}


def red_n(owner_map):
    return sum(1 for o, _ in owner_map.values() if o == HUMAN)


def grid_html(nodes_by_id, ring=set()):
    """nodes_by_id: id -> (owner, strength). Render via each node's (row,col)."""
    # need positions: caller passes a dict id->(row,col) via globals stash
    cells = {}
    for nid, (o, s) in nodes_by_id.items():
        r, c = POS[nid]
        ringed = ' ring' if nid in ring else ''
        cells[(r, c)] = (f'<div class="node{ringed}" style="background:{COLORS.get(o,"#555")}">'
                         f'<span class="s">{s}</span></div>')
    rows = []
    for r in range(7):
        tds = []
        for c in range(6):
            tds.append(f'<td>{cells.get((r,c),"")}</td>')
        rows.append('<tr>' + ''.join(tds) + '</tr>')
    return '<table class="board">' + ''.join(rows) + '</table>'


POS = {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-round', type=int, default=2)
    ap.add_argument('--ksim', type=int, default=60)
    ap.add_argument('--top', type=int, default=12)
    ap.add_argument('--out', default='botdiff.html')
    ap.add_argument('files', nargs='*', default=[
        'runs/series_20260621_battle.jsonl', 'runs/series_20260622_prsearch.jsonl'])
    args = ap.parse_args()

    cases = []
    for f in args.files:
        for line in open(f):
            r = json.loads(line)
            if r.get('type') != 'game': continue
            traj = r.get('trajectory', [])
            for i in range(len(traj) - 1):
                rnd = traj[i].get('round')
                if rnd is None or rnd > args.max_round: continue
                b = board_js(traj[i])
                if not b or len(b['nodes']) != 30: continue
                nxt = traj[i + 1].get('board_before')
                if not nxt or len(nxt) != 30: continue
                before = {n['id']: (n['owner'], n['strength']) for n in b['nodes']}
                pos = {n['id']: (n['row'], n['col']) for n in b['nodes']}
                real = {n['id']: (n['o'], n['s'] if n['s'] is not None else 0) for n in nxt}
                # sim distribution of red count + one representative sim board near the median
                sims = []
                for k in range(args.ksim):
                    om = sim_once(b, 0xABCD ^ (k * 2654435761))
                    sims.append(om)
                simred = [red_n(om) for om in sims]
                sm = st.mean(simred)
                actual_red = red_n(real)
                # representative sim = the run whose red count is closest to the median
                med = st.median(simred)
                rep = min(sims, key=lambda om: abs(red_n(om) - med))
                # red nodes reality took that this rep sim did NOT
                ring = {nid for nid, (o, _) in before.items() if o == HUMAN
                        and real.get(nid, ('red',))[0] != 'red'
                        and rep.get(nid, ('red',))[0] == 'red'}
                cases.append({
                    'game': r.get('game_index'), 'round': rnd, 'result': r.get('result'),
                    'actual_red': actual_red, 'sim_red': sm, 'div': sm - actual_red,
                    'before': before, 'real': real, 'sim': rep, 'pos': pos, 'ring': ring,
                })
    cases.sort(key=lambda c: -c['div'])
    top = cases[:args.top]

    css = """
    body{font-family:-apple-system,system-ui,sans-serif;background:#1c1c1e;color:#eee;margin:20px}
    h1{font-size:20px} .case{margin:26px 0;padding:14px;background:#2c2c2e;border-radius:10px}
    .case h2{font-size:15px;margin:0 0 10px;color:#ddd}
    .panels{display:flex;gap:26px;align-items:flex-start}
    .panel{text-align:center} .panel .lbl{font-size:12px;color:#aaa;margin-bottom:6px;font-weight:600}
    table.board{border-collapse:collapse} td{width:42px;height:42px;padding:2px}
    .node{width:38px;height:38px;border-radius:7px;display:flex;align-items:center;justify-content:center;
          box-shadow:inset 0 -2px 3px rgba(0,0,0,.3)}
    .node .s{font-weight:700;font-size:15px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)}
    .node.ring{outline:3px solid #fff;outline-offset:1px;animation:none}
    .legend{margin:8px 0 18px;font-size:13px} .sw{display:inline-block;width:13px;height:13px;border-radius:3px;
          vertical-align:middle;margin:0 4px 0 12px} .note{color:#f1c40f}
    """
    html = [f'<!doctype html><meta charset=utf8><title>bot-phase divergence</title><style>{css}</style>']
    html.append('<h1>Live bot-phase divergence — real game vs our sim (best_bot_move + reinforce)</h1>')
    leg = ''.join(f'<span class="sw" style="background:{COLORS[k]}"></span>{k}' for k in COLORS)
    html.append(f'<div class="legend">{leg} &nbsp;|&nbsp; <b>BEFORE</b>=after red’s attacks, '
                'pre bot-phase &nbsp; <b>REAL AFTER</b>=actual next round &nbsp; '
                '<b>SIM AFTER</b>=our reinforce(red)+bots (median run). '
                '<span class="note">White ring</span> = red node the REAL bots took but our sim did not.</div>')
    global POS
    for c in top:
        POS = c['pos']
        html.append('<div class="case">')
        html.append(f'<h2>game {c["game"]} · round {c["round"]} · {c["result"]} &nbsp;—&nbsp; '
                    f'red ended with <b>{c["actual_red"]}</b> nodes (real) vs '
                    f'<b>{c["sim_red"]:.1f}</b> predicted by sim &nbsp; '
                    f'(Δ {c["div"]:+.1f} = real punished red {c["div"]:.1f} nodes harder)</h2>')
        html.append('<div class="panels">')
        for lbl, bd, ring in [('BEFORE (after red’s attacks)', c['before'], set()),
                              ('REAL AFTER', c['real'], c['ring']),
                              ('SIM AFTER (our engine)', c['sim'], set())]:
            html.append(f'<div class="panel"><div class="lbl">{lbl}</div>{grid_html(bd, ring)}</div>')
        html.append('</div></div>')
    out = os.path.join(HERE, args.out)
    open(out, 'w').write('\n'.join(html))
    print(f'wrote {out}  ({len(top)} cases, ranked by real-vs-sim divergence)')
    print('top divergences (sim_red - actual_red):',
          [f'{c["div"]:+.1f}' for c in top])


if __name__ == '__main__':
    main()
