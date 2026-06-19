"""AlphaGo-style search for Network Wars RED.

The opponents are the fixed deterministic bots, so from RED's seat this is a
*single-agent* stochastic planning problem: the only randomness is the battle
dice. We run open-loop PUCT MCTS over RED's actions (each action = one attack or
end-turn), guided by a neural net that supplies:

  * a POLICY prior over the 289 actions (which attack to try), and
  * a VALUE estimate of RED's win probability at the leaf (no rollouts).

"Open-loop" = every simulation re-samples the dice from the root with a PRIVATE
RNG that is independent of the game's hidden seed (no seed exploitation); tree
statistics therefore average over chance. Bots run inside the end-turn
transition, so the tree naturally looks many turns ahead, with the value net
truncating each line.

Usage:
  uv run python mcts.py policy_cnn_v5.pt --games 100 --sims 100
"""

import argparse
import importlib
import math

import numpy as np
import torch

import network_wars as nw
from network_wars import (
    HUMAN, BOTS, FACTIONS, MAX_TURNS, WIN_NODES, DIRS, END_TURN, GRID_COLS,
    make_rng, build_board, make_game, counts, check_winner, resolve_battle,
    reinforce, run_bot_turn, best_bot_move, legal_moves, components_of,
    Node as GNode, State,
)

# --- seed-free private RNG for simulated dice -------------------------------
_sim_ctr = 0x12345678
def _next_rng():
    global _sim_ctr
    _sim_ctr = (_sim_ctr + 0x9E3779B9) & nw.M32
    return make_rng(_sim_ctr)


def clone_state(src, rng):
    """Copy owners/strengths into a fresh State; topology (adj/links) is shared
    (never mutated). `rng` drives all simulated battles."""
    s = State()
    s.nodes = [GNode(n.id, n.x, n.y, n.owner, n.strength) for n in src.nodes]
    s.adj = src.adj
    s.links = src.links
    s.rng = rng
    s.policy_rng = rng
    return s


# --- action <-> move plumbing (mirrors network_wars env encoding) -----------
def coord_map(state):
    return {(n.y, n.x): n.id for n in state.nodes}


def legal_action_indices(state, c2id):
    acts = []
    for frm, to in legal_moves(state, HUMAN):
        a, b = state.nodes[frm], state.nodes[to]
        d = DIRS.index((b.y - a.y, b.x - a.x))
        acts.append((a.y * GRID_COLS + a.x) * len(DIRS) + d)
    acts.append(END_TURN)
    return acts


def apply_action(state, turns, action, c2id):
    """Pure transition mirroring NetworkWarsEnv.step. Returns
    (new_turns, terminated, winner)."""
    if action == END_TURN:
        reinforce(state, HUMAN)
        w = check_winner(state)
        if w is None:
            for bot in BOTS:
                run_bot_turn(state, bot)
                w = check_winner(state)
                if w:
                    break
        turns += 1
    else:
        cell, d = divmod(int(action), len(DIRS))
        y, x = divmod(cell, GRID_COLS)
        dy, dx = DIRS[d]
        frm = c2id.get((y, x))
        to = c2id.get((y + dy, x + dx))
        if (frm is not None and to is not None
                and state.nodes[frm].owner == HUMAN
                and state.nodes[frm].strength > 1
                and state.nodes[to].owner != HUMAN
                and to in state.adj[frm]):
            resolve_battle(state, frm, to)
        w = check_winner(state)
    red = counts(state)[HUMAN]
    terminated = w is not None or red == 0
    return turns, terminated, w


# --- neural evaluator -------------------------------------------------------
class Evaluator:
    """Returns (priors[289], win_prob) for a state. Priors come from `policy`'s
    action head; the value comes from `value_net` if provided (a calibrated
    win-prob net), else from `policy`'s own value head. The value scalar is
    treated as a logit -> sigmoid = win prob."""

    def __init__(self, policy, value_net=None):
        self.policy = policy
        self.value_net = value_net
        self._env = nw.NetworkWarsEnv()      # throwaway, only _obs() is used

    def obs(self, state, turns):
        self._env.state = state
        self._env.turns = turns
        return self._env._obs()

    @torch.no_grad()
    def __call__(self, state, turns):
        o = torch.as_tensor(self.obs(state, turns)).unsqueeze(0)
        logits, value = self.policy.forward_eval(o)
        priors = torch.softmax(logits[0], dim=-1).numpy()
        if self.value_net is not None:
            _, value = self.value_net.forward_eval(o)
        winp = float(torch.sigmoid(value[0]).item())
        return priors, winp


# --- open-loop PUCT MCTS ----------------------------------------------------
class TreeNode:
    __slots__ = ('N', 'W', 'P', 'child', 'expanded', 'v', 'terminal')

    def __init__(self):
        self.N = {}        # action -> visit count
        self.W = {}        # action -> summed value
        self.P = {}        # action -> prior
        self.child = {}    # action -> TreeNode
        self.expanded = False
        self.terminal = False
        self.v = 0.5


def _select(node, legal, c_puct):
    total = 0
    for a in legal:
        total += node.N.get(a, 0)
    sqrt_total = math.sqrt(total) + 1e-8
    best_a, best_u = legal[0], -1e30
    for a in legal:
        n = node.N.get(a, 0)
        q = (node.W[a] / n) if n > 0 else node.v   # FPU = parent value
        p = node.P.get(a, 1e-3)
        u = q + c_puct * p * sqrt_total / (1 + n)
        if u > best_u:
            best_u, best_a = u, a
    return best_a


def _backup(path, value):
    for node, a in path:
        node.N[a] = node.N.get(a, 0) + 1
        node.W[a] = node.W.get(a, 0.0) + value


def rollout_to_terminal(state, turns):
    """Pure-engine playout to the end: RED plays bot-style (attack the weakest
    strictly-beatable neighbour), the bots play their turns. Returns 1.0 if RED
    wins, else 0.0. Used as the leaf evaluator in --leaf rollout mode (no value
    net). Mutates `state` (a throwaway sim clone) using its private RNG."""
    while True:
        w = check_winner(state)
        if w is not None:
            return 1.0 if w == HUMAN else 0.0
        if counts(state)[HUMAN] == 0:
            return 0.0
        g = 0
        while g < 500:                       # RED's turn, greedy bot-style
            mv = best_bot_move(state, HUMAN)
            if mv is None:
                break
            resolve_battle(state, mv[0], mv[1])
            if check_winner(state):
                break
            g += 1
        w = check_winner(state)
        if w is not None:
            return 1.0 if w == HUMAN else 0.0
        reinforce(state, HUMAN)
        w = check_winner(state)
        if w is not None:
            return 1.0 if w == HUMAN else 0.0
        for bot in BOTS:
            run_bot_turn(state, bot)
            if check_winner(state):
                break
        w = check_winner(state)
        if w is not None:
            return 1.0 if w == HUMAN else 0.0
        turns += 1
        if turns > MAX_TURNS:
            c = counts(state)
            return 1.0 if c[HUMAN] > max(c[f] for f in BOTS) else 0.0


def mcts_search(root_state, root_turns, ev, c2id, sims, c_puct=1.5,
                dirichlet=0.0, rng_noise=None, leaf='value', priors='net'):
    """leaf: 'value' (value-net leaf eval) or 'rollout' (playout to terminal).
    priors: 'net' (policy-net priors) or 'uniform' (pure UCT, no net)."""
    root = TreeNode()
    for i in range(sims):
        state = clone_state(root_state, _next_rng())
        turns = root_turns
        node = root
        path = []
        while True:
            if not node.expanded:
                legal = legal_action_indices(state, c2id)
                if priors == 'net':
                    p_arr, v_net = ev(state, turns)
                    for a in legal:
                        node.P[a] = p_arr[a]
                else:                                   # uniform priors (pure UCT)
                    v_net = None
                    for a in legal:
                        node.P[a] = 1.0 / len(legal)
                if leaf == 'rollout':
                    v = rollout_to_terminal(state, turns)   # mutates throwaway clone
                else:
                    v = v_net if v_net is not None else ev(state, turns)[1]
                node.expanded = True
                node.v = v
                # optional root exploration noise (self-play only)
                if dirichlet > 0.0 and node is root and rng_noise is not None:
                    noise = rng_noise.dirichlet([dirichlet] * len(legal))
                    for k, a in enumerate(legal):
                        node.P[a] = 0.75 * node.P[a] + 0.25 * noise[k]
                _backup(path, v)
                break
            legal = legal_action_indices(state, c2id)
            a = _select(node, legal, c_puct)
            path.append((node, a))
            turns, terminated, winner = apply_action(state, turns, a, c2id)
            nxt = node.child.get(a)
            if nxt is None:
                nxt = TreeNode()
                node.child[a] = nxt
            node = nxt
            if terminated:
                val = 1.0 if winner == HUMAN else 0.0
                node.expanded = True
                node.terminal = True
                node.v = val
                _backup(path, val)
                break
            if turns > MAX_TURNS:
                _backup(path, 0.0)
                break
    return root


def best_action(root, legal, by='visits'):
    if by == 'visits':
        return max(legal, key=lambda a: root.N.get(a, 0))
    return max(legal, key=lambda a: (root.W.get(a, 0.0) / root.N[a]) if root.N.get(a, 0) else -1)


# --- play a full game with MCTS as RED --------------------------------------
def play_game(ev, seed, sims, c_puct=1.5, max_actions=4000, leaf='value', priors='net'):
    state = make_game(seed)              # REAL game (real hidden dice)
    c2id = coord_map(state)
    turns = 1
    for _ in range(max_actions):
        w = check_winner(state)
        if w is not None or counts(state)[HUMAN] == 0:
            break
        legal = legal_action_indices(state, c2id)
        if len(legal) == 1:              # only END_TURN
            action = END_TURN
        else:
            root = mcts_search(state, turns, ev, c2id, sims, c_puct,
                               leaf=leaf, priors=priors)
            action = best_action(root, legal, by='visits')
        # apply to the REAL state with the REAL rng
        if action == END_TURN:
            reinforce(state, HUMAN)
            if not check_winner(state):
                for bot in BOTS:
                    run_bot_turn(state, bot)
                    if check_winner(state):
                        break
            turns += 1
        else:
            cell, d = divmod(int(action), len(DIRS))
            y, x = divmod(cell, GRID_COLS)
            dy, dx = DIRS[d]
            frm = c2id.get((y, x)); to = c2id.get((y + dy, x + dx))
            if frm is not None and to is not None:
                resolve_battle(state, frm, to)
        if turns > MAX_TURNS:
            break
    winner = check_winner(state)
    return winner == HUMAN, turns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('checkpoint', nargs='?', default='policy_cnn_v5.pt')
    ap.add_argument('--policy', default='policy_cnn')
    ap.add_argument('--games', type=int, default=100)
    ap.add_argument('--seed-base', type=int, default=1)
    ap.add_argument('--sims', type=int, default=100)
    ap.add_argument('--c-puct', type=float, default=1.5)
    ap.add_argument('--value-net', default=None,
                    help='optional separate calibrated value checkpoint (value_net.py)')
    ap.add_argument('--leaf', default='value', choices=['value', 'rollout'],
                    help="leaf eval: value net, or playout to terminal (no value net)")
    ap.add_argument('--priors', default='net', choices=['net', 'uniform'],
                    help="PUCT priors: policy net, or uniform (pure UCT)")
    flags = ap.parse_args()

    from evaluate import _EnvShim
    policy = importlib.import_module(flags.policy).Policy(_EnvShim(nw.OBS_DIM))
    policy.load_state_dict(torch.load(flags.checkpoint, map_location='cpu'))
    policy.eval()
    value_net = None
    if flags.value_net:
        value_net = importlib.import_module(flags.policy).Policy(_EnvShim(nw.OBS_DIM))
        value_net.load_state_dict(torch.load(flags.value_net, map_location='cpu'))
        value_net.eval()
    ev = Evaluator(policy, value_net)

    import time
    t0 = time.time()
    wins, twin, tot = 0, [], 0
    for s in range(flags.seed_base, flags.seed_base + flags.games):
        won, turns = play_game(ev, s, flags.sims, flags.c_puct,
                               leaf=flags.leaf, priors=flags.priors)
        tot += turns
        if won:
            wins += 1
            twin.append(turns)
    dt = time.time() - t0
    print(f'MCTS({flags.checkpoint}, sims={flags.sims}, c={flags.c_puct}, '
          f'leaf={flags.leaf}, priors={flags.priors}) — '
          f'{flags.games} games seeds {flags.seed_base}..{flags.seed_base+flags.games-1}')
    print(f'  winrate     : {wins/flags.games*100:.1f}%  ({wins}/{flags.games})')
    print(f'  avgTurns→win: {np.mean(twin):.2f}' if twin else '  avgTurns→win: —')
    print(f'  time        : {dt:.1f}s total, {dt/flags.games*1000:.0f} ms/game')


if __name__ == '__main__':
    main()
