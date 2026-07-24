"""Audit the web UI's sweep-up offer: how often does an OFFERED sweep actually lose?

The frontend (public/index.html, public/head-to-head.html) offers to auto-play the
rest of the game with a greedy mop-up policy when a search says EVERY legal root
move still wins > SWEEP_Q (0.9995). Two things could make that offer unsafe:

  1. RESOLUTION. q is the mean of 0/1 rollouts, so its quantum is 1/visits. A root
     child with v visits can only report q = 1.0 or <= 1 - 1/v. With the live
     budgets (h2h 4000-8000 sims spread over nc children; index has NO root visit
     floor at all because it doesn't ask for grading mode) 1 - 1/v is already far
     below 0.9995, so the test degenerates to "zero losing rollouts observed" and
     the threshold value itself does nothing.
  2. POLICY. The certificate covers ONE move under SEARCH play. The sweep then
     plays a greedy heuristic for the whole rest of the game and never re-checks.

This measures both: play a game, at every RED decision run the exact live trigger
searches, and the first time one fires, freeze the position and play the greedy
sweep policy to terminal K times with fresh dice. P(loss | offered) is the answer.

    uv run python sweep_audit.py --seeds 1-40 --out /tmp/sweep.jsonl
    uv run python sweep_audit.py --report /tmp/sweep*.jsonl
"""
import argparse
import glob
import json
import math
import sys

import numpy as np

import fastnw

RED = 0
MAX_TURNS = 400          # engine's own cap (see fast_engine.c MAX_TURNS)
SWEEP_Q = 0.9995

# The live worker's value-stop config (public/engine.worker.js).
VS = (0.03, 0.97, 0.15, 512)

# The two shapes the pages actually search with at the moment of the offer.
CONFIGS = {
    # head-to-head.html: explicit grading mode, small budget.
    'h2h':   dict(grade=1, sims=4000, max_sims=8000),
    # index.html: piggybacks on the play search; grade only if the blunder alert
    # is on, so with sweep alone it is grade=0 -> no root visit floor.
    'index': dict(grade=0, sims=6000, max_sims=150000),
}
# A high-resolution reference: honest cross-move Qs with enough visits per child
# that 1 - 1/v actually lives above the threshold.
REF = dict(grade=1, sims=48000, max_sims=48000, no_vs=True)


def search(owner, strength, turns, cfg, sim_seed):
    fastnw.use_sim(sim_seed)
    fastnw.set_grade(cfg.get('grade', 0))
    if cfg.get('no_vs'):
        fastnw.set_value_stop()                  # off
    else:
        fastnw.set_value_stop(*VS)
    acts, visits, q = fastnw.uct_search(owner, strength, turns, cfg['sims'],
                                        max_sims=cfg['max_sims'], return_q=True)
    spent = fastnw.sims_done()
    fastnw.set_grade(0)
    fastnw.set_value_stop()
    return acts, visits, q, spent


def fires(q):
    return len(q) > 0 and bool(np.all(q > SWEEP_Q))


def sweep_move(owner, strength, adj):
    """Exactly public/*.html sweepMove(): strongest attacker first, biggest margin
    breaks ties, first-found wins exact ties (same legal-move order as the JS)."""
    best, bs, bm = None, 0, 0
    for (frm, to) in fastnw.legal_moves(owner, strength, adj):
        a, d = strength[frm], strength[to]
        if a <= d:
            continue
        if best is None or a > bs or (a == bs and a - d > bm):
            best, bs, bm = (frm, to), a, a - d
    return best


def terminal(owner):
    """Engine winner, plus the worker's extra rule: RED at 0 nodes = game over."""
    w = fastnw.check_winner(owner)
    if w >= 0:
        return w
    if fastnw.counts(owner)[RED] == 0:
        return 1                                 # red wiped -> a loss
    return -1


def greedy_playout(owner0, strength0, turns, adj, mb_seed):
    """Play the sweep's own greedy policy to terminal on a fresh dice stream."""
    owner, strength = owner0.copy(), strength0.copy()
    fastnw.use_mb32(mb_seed)
    acts = 0
    for _ in range(4000):
        w = terminal(owner)
        if w >= 0:
            return w == RED, acts
        m = sweep_move(owner, strength, adj)
        acts += 1
        if m is not None:
            fastnw.resolve_battle(owner, strength, m[0], m[1])
        else:
            fastnw.end_turn(owner, strength)     # red reinforce + all four bot turns
            turns += 1
            if turns > MAX_TURNS:
                return False, acts
    return False, acts


def search_playout(owner0, strength0, turns, mb_seed, sim_seed, sims=2000):
    """Same mop-up, but each move is the SEARCH's move (what the certificate was
    actually about) instead of the greedy heuristic."""
    owner, strength = owner0.copy(), strength0.copy()
    mb = mb_seed & 0xFFFFFFFF
    acts = 0
    for _ in range(4000):
        w = terminal(owner)
        if w >= 0:
            return w == RED, acts
        fastnw.use_sim(sim_seed + acts)
        fastnw.set_value_stop(*VS)
        a, v = fastnw.uct_search(owner, strength, turns, sims, max_sims=8 * sims)
        fastnw.set_value_stop()
        action = -1 if len(a) == 0 else int(a[int(np.argmax(v))])
        acts += 1
        fastnw.use_mb32(mb)
        if action < 0:
            fastnw.end_turn(owner, strength)
            turns += 1
            if turns > MAX_TURNS:
                return False, acts
        else:
            fastnw.resolve_battle(owner, strength, action >> 8, action & 0xFF)
        mb = fastnw.get_mb32()
    return False, acts


def reverify_playout(owner0, strength0, turns, adj, mb_seed, sim_seed):
    """Greedy, but re-run the trigger test before every action and hand the game
    back to the human the moment it stops firing. Returns (won, handed_back)."""
    owner, strength = owner0.copy(), strength0.copy()
    mb = mb_seed & 0xFFFFFFFF
    acts = 0
    for _ in range(4000):
        w = terminal(owner)
        if w >= 0:
            return w == RED, False
        _, _, q, _ = search(owner, strength, turns, CONFIGS['h2h'], sim_seed + acts)
        if not fires(q):
            return None, True
        m = sweep_move(owner, strength, adj)
        acts += 1
        fastnw.use_mb32(mb)
        if m is not None:
            fastnw.resolve_battle(owner, strength, m[0], m[1])
        else:
            fastnw.end_turn(owner, strength)
            turns += 1
            if turns > MAX_TURNS:
                return False, False
        mb = fastnw.get_mb32()
    return False, False


def audit_seed(seed, k_playouts, sim_seed, noise, rng, k_alt=0):
    """Play one game with the live search; at the first trigger, measure."""
    g = fastnw.new_game(seed)
    fastnw.set_topology_csr(g['n'], g['adj'])
    adj = g['adj']
    owner, strength = g['owner'].copy(), g['strength'].copy()
    mb = g['mb']
    turns = 1
    for _ in range(6000):
        if terminal(owner) >= 0:
            return None
        # --- the live trigger searches (both page configs, same position) ---
        probe = {}
        for name, cfg in CONFIGS.items():
            a, v, q, spent = search(owner, strength, turns, cfg, sim_seed)
            probe[name] = dict(nc=len(q), spent=spent, minvis=int(v.min()) if len(v) else 0,
                               minq=float(q.min()) if len(q) else 1.0,
                               fires=fires(q))
        hit = [n for n in CONFIGS if probe[n]['fires']]
        if hit:
            a, v, q, spent = search(owner, strength, turns, REF, sim_seed + 1)
            probe['ref'] = dict(nc=len(q), spent=spent,
                                minvis=int(v.min()) if len(v) else 0,
                                minq=float(q.min()) if len(q) else 1.0,
                                maxq=float(q.max()) if len(q) else 1.0,
                                fires=fires(q))
            wins, lens = 0, []
            for i in range(k_playouts):
                won, n = greedy_playout(owner, strength, turns, adj,
                                        (seed * 7919 + i * 104729) & 0xFFFFFFFF)
                wins += won
                lens.append(n)
            row = dict(seed=seed, turns=turns, red=int(fastnw.counts(owner)[RED]),
                       fired=hit, probe=probe, k=k_playouts, greedy_wins=wins,
                       greedy_len=float(np.mean(lens)))
            if k_alt:
                sw = sum(search_playout(owner, strength, turns,
                                        (seed * 7919 + i * 104729) & 0xFFFFFFFF,
                                        sim_seed + 17 * i)[0] for i in range(k_alt))
                rv = [reverify_playout(owner, strength, turns, adj,
                                       (seed * 7919 + i * 104729) & 0xFFFFFFFF,
                                       sim_seed + 31 * i) for i in range(k_alt)]
                row.update(k_alt=k_alt, search_wins=sw,
                           rv_wins=sum(1 for w, _ in rv if w),
                           rv_back=sum(1 for _, b in rv if b),
                           rv_losses=sum(1 for w, b in rv if w is False and not b))
            return row
        # --- main line: play the search's best move (optionally noisy) ---
        fastnw.use_sim(sim_seed)
        fastnw.set_value_stop(*VS)
        acts, visits = fastnw.uct_search(owner, strength, turns, 6000, max_sims=150000)
        fastnw.set_value_stop()
        if len(acts) == 0:
            action = -1
        elif noise > 0 and rng.random() < noise:
            action = int(acts[rng.integers(len(acts))])
        else:
            action = int(acts[int(np.argmax(visits))])
        fastnw.use_mb32(mb)
        if action < 0:
            fastnw.end_turn(owner, strength)
            turns += 1
        else:
            frm, to = action >> 8, action & 0xFF
            fastnw.resolve_battle(owner, strength, frm, to)
        mb = fastnw.get_mb32()
        if turns > MAX_TURNS:
            return None
    return None


def report(paths):
    rows = []
    for p in paths:
        for pat in glob.glob(p):
            with open(pat) as f:
                rows += [json.loads(l) for l in f if l.strip()]
    games = len(rows)
    rows = [r for r in rows if r.get('probe')]
    if not rows:
        print('no rows'); return
    print(f'{games} games played, {len(rows)} of them offered a sweep\n')
    for name in list(CONFIGS) + ['both']:
        sub = [r for r in rows if (set(r['fired']) == set(CONFIGS) if name == 'both'
                                   else name in r['fired'])]
        if not sub:
            continue
        n = sum(r['k'] for r in sub)
        w = sum(r['greedy_wins'] for r in sub)
        lost_games = sum(1 for r in sub if r['greedy_wins'] < r['k'])
        pl = 1 - w / n
        se = math.sqrt(pl * (1 - pl) / n)
        print(f'{name:6s}  positions={len(sub):4d}  playouts={n:6d}  '
              f'greedy loss rate={100*pl:6.3f}% (+-{100*1.96*se:.3f})  '
              f'positions with >=1 loss: {lost_games}/{len(sub)}')
        if name != 'both':
            mv = [r['probe'][name]['minvis'] for r in sub]
            nc = [r['probe'][name]['nc'] for r in sub]
            sp = [r['probe'][name]['spent'] for r in sub]
            tn = [r['turns'] for r in sub]
            rd = [r['red'] for r in sub]
            print(f'        tail-move visits: min={min(mv)} median={int(np.median(mv))} '
                  f'| root moves median={int(np.median(nc))} | sims median={int(np.median(sp))}')
            print(f'        offered at: turn median={int(np.median(tn))} (min {min(tn)}) | '
                  f'RED nodes median={int(np.median(rd))} (min {min(rd)}, 24 = win) | '
                  f'nc==1 (vacuous "every move") in {sum(1 for c in nc if c == 1)}/{len(sub)}')
        alt = [r for r in sub if r.get('k_alt')]
        if alt:
            ka = sum(r['k_alt'] for r in alt)
            print(f'        same positions, {ka} playouts each: '
                  f"SEARCH-policy sweep loses {100*(1-sum(r['search_wins'] for r in alt)/ka):.2f}% | "
                  f"greedy+re-verify: {sum(r['rv_back'] for r in alt)} handed back, "
                  f"{sum(r['rv_losses'] for r in alt)} lost")
    # would the high-resolution reference have suppressed the losing offers?
    ref = [r for r in rows if 'ref' in r['probe']]
    bad = [r for r in ref if r['greedy_wins'] < r['k']]
    print(f'\nreference search ({REF["sims"]} sims, grading, no value-stop) on the '
          f'{len(ref)} offered positions:')
    print(f'  ref would also fire on {sum(1 for r in ref if r["probe"]["ref"]["fires"])}/{len(ref)}')
    print(f'  of the {len(bad)} positions where greedy ever lost, ref fires on '
          f'{sum(1 for r in bad if r["probe"]["ref"]["fires"])}')
    for r in sorted(bad, key=lambda r: r['greedy_wins'])[:15]:
        pr = r['probe']
        print(f"  seed {r['seed']:5d} turn {r['turns']:3d} red={r['red']:2d} "
              f"fired={'+'.join(r['fired']):11s} greedy {r['greedy_wins']}/{r['k']} "
              f"| ref minq={pr['ref']['minq']:.4f} minvis={pr['ref']['minvis']} "
              f"fires={pr['ref']['fires']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seeds', default='1-20', help='inclusive range a-b')
    ap.add_argument('--k', type=int, default=400, help='greedy playouts per trigger')
    ap.add_argument('--k-alt', type=int, default=0,
                    help='playouts for the search-policy and re-verify variants')
    ap.add_argument('--noise', type=float, default=0.0,
                    help='prob of a random (human-sloppy) main-line move')
    ap.add_argument('--sim-seed', type=int, default=0x12345678)
    ap.add_argument('--out', default=None)
    ap.add_argument('--report', nargs='*', default=None)
    a = ap.parse_args()
    if a.report is not None:
        report(a.report or ['/tmp/sweep*.jsonl']); return
    lo, hi = (int(x) for x in a.seeds.split('-'))
    rng = np.random.default_rng(lo)
    out = open(a.out, 'a', buffering=1) if a.out else sys.stdout
    for seed in range(lo, hi + 1):
        r = audit_seed(seed, a.k, a.sim_seed, a.noise, rng, a.k_alt)
        if r is None:
            print(json.dumps(dict(seed=seed, fired=[])), file=out)
            continue
        r['noise'] = a.noise
        print(json.dumps(r), file=out)


if __name__ == '__main__':
    main()
