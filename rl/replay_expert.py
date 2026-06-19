"""Replay modalScout expert games (from dump_expert.js) in the Python engine to
build (obs, expert_action, outcome) training data with Python-consistent obs.

  node dump_expert.js 5000 200000 > expert.jsonl
  uv run python replay_expert.py expert.jsonl --out expert
"""

import argparse
import json

import numpy as np

import network_wars as nw
from network_wars import (
    HUMAN, BOTS, DIRS, END_TURN, GRID_COLS, MAX_TURNS,
    make_game, check_winner, resolve_battle, reinforce, run_bot_turn, counts,
)


def action_index(state, frm, to):
    a, b = state.nodes[frm], state.nodes[to]
    d = DIRS.index((b.y - a.y, b.x - a.x))
    return (a.y * GRID_COLS + a.x) * len(DIRS) + d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('jsonl')
    ap.add_argument('--out', default='expert')
    ap.add_argument('--max-games', type=int, default=0)
    flags = ap.parse_args()

    env = nw.NetworkWarsEnv()
    obs_list, pol_list, val_list = [], [], []
    n_games = 0
    wins = 0
    with open(flags.jsonl) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            seed = rec['seed']
            actions = rec['actions']
            state = make_game(seed)
            turns = 1
            traj = []        # (obs, action_idx)
            for act in actions:
                if check_winner(state) is not None or counts(state)[HUMAN] == 0:
                    break
                env.state = state
                env.turns = turns
                o = env._obs().astype(np.float16)
                if act == 'end':
                    traj.append((o, END_TURN))
                    reinforce(state, HUMAN)
                    if check_winner(state) is None:
                        for bot in BOTS:
                            run_bot_turn(state, bot)
                            if check_winner(state):
                                break
                    turns += 1
                else:
                    frm, to = act
                    traj.append((o, action_index(state, frm, to)))
                    resolve_battle(state, frm, to)
                if turns > MAX_TURNS:
                    break
            won = 1.0 if check_winner(state) == HUMAN else 0.0
            wins += won
            for o, a in traj:
                obs_list.append(o); pol_list.append(a); val_list.append(won)
            n_games += 1
            if flags.max_games and n_games >= flags.max_games:
                break
            if n_games % 1000 == 0:
                print(f'  {n_games} games, {len(obs_list)} states, winrate {wins/n_games:.3f}', flush=True)

    obs = np.stack(obs_list).astype(np.float16)
    pol = np.array(pol_list, dtype=np.int64)
    val = np.array(val_list, dtype=np.float32)
    np.save(f'{flags.out}_obs.npy', obs)
    np.save(f'{flags.out}_pol.npy', pol)
    np.save(f'{flags.out}_val.npy', val)
    print(f'saved {flags.out}_*.npy  {obs.shape} states from {n_games} games, '
          f'replay winrate {wins/n_games:.3f}, value mean {val.mean():.3f}')


if __name__ == '__main__':
    main()
