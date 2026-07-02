#!/usr/bin/env python3
"""Paired-seed A/B over the HARD TEST SET (hard_set.jsonl).

Part 2 of the winrate push. Replays a chosen BAND of the hard openings with the
same (board, dice-seed) pairs under one ARM (engine config), writing per-pair
outcomes so two arms can be compared PAIRED (McNemar on discordant pairs) — the
only way to see a small real effect through battle-dice noise.

Engine variants that need C changes are selected with NW_ENGINE_SO=path; levers
already exposed as setters are plain flags (--c-puct, --sims, --nroll,
--value-stop). One arm per run, like bench_ab.py.

  # baseline arm
  uv run python hard_ab.py --name base --band contested --seeds 40 --sims 8000
  # a variant engine
  NW_ENGINE_SO=./fast_engine_fpu.so uv run python hard_ab.py \
      --name fpu --band contested --seeds 40 --sims 8000
  # compare
  uv run python hard_ab.py --compare hard_base.jsonl hard_fpu.jsonl
"""
import argparse, glob, json, math, os, sys, time
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))


def load_band(path, band, low, high):
    rows = [json.loads(l) for l in open(path)]
    if band == 'contested':
        rows = [r for r in rows if low <= r['winnable'] <= high]
    elif band == 'dice':
        rows = [r for r in rows if r['winnable'] < low]
    elif band == 'easy':
        rows = [r for r in rows if r['winnable'] > high]
    # 'all' -> keep everything
    return rows


def bkey(board):
    import hashlib
    s = json.dumps(sorted((n['id'], n['owner'], n['strength'])
                          for n in board['nodes']))
    return hashlib.md5(s.encode()).hexdigest()[:12]


def run_chunk(arg):
    items, sims, min_sims, c_puct, nroll, value_stop, deepthink = arg
    # engine selected via NW_ENGINE_SO in this worker's env (inherited on fork)
    import numpy as np
    import network_wars as nw
    from network_wars import (HUMAN, BOTS, check_winner, counts, reinforce,
                              run_bot_turn, resolve_battle)
    import fastnw
    import nwmove_fast as NWM
    if value_stop:
        fastnw.set_value_stop(*value_stop[:3], int(value_stop[3]))
    if deepthink:
        fastnw.set_deepthink(deepthink[0], int(deepthink[1]), deepthink[2])

    out = []
    for board, key, sd in items:
        st = NWM.build_state(board)
        st.mb = sd & 0xFFFFFFFF
        st.policy_rng = nw.make_rng((sd ^ 0x9E3779B9) & 0xFFFFFFFF)
        fastnw.set_topology(st)
        fastnw.use_sim(0x12345678 ^ sd)
        turns = 1
        for _ in range(6000):
            if check_winner(st) is not None or counts(st)[HUMAN] == 0:
                break
            fastnw.use_sim(0x12345678 ^ sd)
            owner, strength = fastnw.board_arrays(st)
            acts, visits = fastnw.uct_search(owner, strength, turns, min_sims,
                                             c_puct, nroll, max_sims=sims)
            action = -1 if len(acts) == 0 else int(acts[int(np.argmax(visits))])
            if action == -1:
                reinforce(st, HUMAN)
                if check_winner(st) is None:
                    for b in BOTS:
                        run_bot_turn(st, b)
                        if check_winner(st):
                            break
                turns += 1
            else:
                frm, to = action >> 8, action & 0xFF
                if (st.nodes[frm].owner == HUMAN and st.nodes[frm].strength > 1
                        and st.nodes[to].owner != HUMAN and to in st.adj[frm]):
                    resolve_battle(st, frm, to)
                else:
                    reinforce(st, HUMAN)
                    if check_winner(st) is None:
                        for b in BOTS:
                            run_bot_turn(st, b)
                            if check_winner(st):
                                break
                    turns += 1
            if turns > nw.MAX_TURNS:
                break
        out.append({'key': key, 'seed': sd,
                    'won': check_winner(st) == HUMAN})
    return out


def compare(files, low=0.40, high=0.85):
    runs = []
    for f in files:
        rows = [json.loads(l) for l in open(f)]
        runs.append({(r['key'], r['seed']): r['won'] for r in rows})
    base = runs[0]
    for f, run in zip(files, runs):
        pairs = sorted(run)
        n = len(pairs)
        w = sum(run[p] for p in pairs)
        line = f'{os.path.basename(f)}: {w}/{n} = {w/n*100:.1f}%'
        if run is not base:
            common = [p for p in pairs if p in base]
            ab = sum(1 for p in common if run[p] and not base[p])
            ba = sum(1 for p in common if base[p] and not run[p])
            z = (ab - ba) / math.sqrt(ab + ba) if (ab + ba) else 0.0
            line += (f'  | vs {os.path.basename(files[0])}: +{ab}/-{ba} '
                     f'discordant of {len(common)}, z={z:+.2f}')
        print(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--compare', nargs='+')
    ap.add_argument('--set', default=os.path.join(HERE, 'hard_set.jsonl'))
    ap.add_argument('--band', default='contested',
                    choices=['contested', 'dice', 'easy', 'all'])
    ap.add_argument('--low', type=float, default=0.40)
    ap.add_argument('--high', type=float, default=0.85)
    ap.add_argument('--name', default='arm')
    ap.add_argument('--seeds', type=int, default=40)
    ap.add_argument('--seed-base', type=int, default=1000)
    ap.add_argument('--sims', type=int, default=8000)
    ap.add_argument('--min-sims', type=int, default=0,
                    help='adaptive floor (0 = fixed --sims); move-identical early stop')
    ap.add_argument('--c-puct', type=float, default=2.5)
    ap.add_argument('--nroll', type=int, default=1)
    ap.add_argument('--value-stop', nargs=4, type=float,
                    metavar=('LO', 'HI', 'GAP', 'MINVIS'))
    ap.add_argument('--deepthink', nargs=3, type=float,
                    metavar=('RATIO', 'MINVIS', 'BEHIND'),
                    help='relative-margin early stop (uct_set_deepthink)')
    ap.add_argument('--workers', type=int, default=9)
    a = ap.parse_args()

    if a.compare:
        compare(a.compare, a.low, a.high)
        return

    rows = load_band(a.set, a.band, a.low, a.high)
    seeds = list(range(a.seed_base, a.seed_base + a.seeds))
    items = [(r['board'], bkey(r['board']), sd) for r in rows for sd in seeds]
    print(f"arm '{a.name}': {len(rows)} openings ({a.band}) x {a.seeds} seeds "
          f"= {len(items)} games @ {a.sims} sims  "
          f"[engine={os.environ.get('NW_ENGINE_SO','fast_engine.so')}]", flush=True)

    chunks = [items[i::a.workers] for i in range(a.workers)]
    tasks = [(c, a.sims, a.min_sims or a.sims, a.c_puct, a.nroll, a.value_stop,
              a.deepthink) for c in chunks if c]
    t0 = time.time()
    with Pool(a.workers) as pool:
        res = pool.map(run_chunk, tasks)
    flat = [r for ch in res for r in ch]
    out = os.path.join(HERE, f'hard_{a.name}.jsonl')
    with open(out, 'w') as f:
        for r in flat:
            f.write(json.dumps(r) + '\n')
    w = sum(r['won'] for r in flat)
    dt = time.time() - t0
    print(f"{a.name}: {w}/{len(flat)} = {w/len(flat)*100:.1f}%  "
          f"[{dt:.0f}s]  -> {os.path.basename(out)}", flush=True)


if __name__ == '__main__':
    main()
