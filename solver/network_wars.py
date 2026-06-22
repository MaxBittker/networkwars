"""Network Wars — readable Python interface to the C engine (the source of truth).

The rules, board generation, and search all live in fast_engine.c; this module is
a thin shim that keeps the convenient Python object interface (State/Node + the
rule functions) the analysis tooling is written against, delegating every rule to
the C engine via fastnw. There is no second rules implementation.

The two re-calibrated mechanics (see solver/BATTLE_FUNCTION.md and the memories
sim-vs-real-deal-imbalance / sim-vs-real-battle-mismatch) live in the C engine:
the iOS deal (every faction totals 20, 4 fixed templates) and the power-ratio
battle. game.js / a JS port no longer exist — the browser talks to this same C
engine over HTTP via solver/server.py.
"""
import fastnw

FACTIONS = fastnw.FACTIONS
BOTS = ['green', 'yellow', 'blue', 'purple']
HUMAN = 'red'
FIDX = fastnw.FIDX

GRID_ROWS = 7
GRID_COLS = 6
TARGET_NODES = 30
WIN_NODES = 24
MAX_TURNS = 300
M32 = 0xFFFFFFFF

# The iOS deal templates (each faction's 6 strengths sum to 20), kept here for
# reference/analysis; the authoritative copy that drives play is in fast_engine.c.
IOS_DEAL_TEMPLATES = [
    ((1, 1, 1, 5, 6, 6), 0.385),
    ((1, 1, 1, 1, 8, 8), 0.327),
    ((1, 1, 4, 4, 5, 5), 0.222),
    ((1, 3, 4, 4, 4, 4), 0.066),
]


def make_rng(seed):
    """Seeded mulberry32 as a Python callable (bit-identical to the C stream), for
    code that needs its own deterministic stream (e.g. policy move selection)."""
    s = seed & M32

    def rng():
        nonlocal s
        s = (s + 0x6D2B79F5) & M32
        t = ((s ^ (s >> 15)) * (s | 1)) & M32
        t = ((t + (((t ^ (t >> 7)) * (t | 61)) & M32)) ^ t) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rng


class Node:
    __slots__ = ('id', 'x', 'y', 'owner', 'strength')

    def __init__(self, id, x, y, owner, strength):
        self.id, self.x, self.y = id, x, y
        self.owner, self.strength = owner, strength


class State:
    """A board plus its adjacency. `mb` is the real mulberry32 stream position (the
    battle dice); `policy_rng` is a separate Python stream for policy selection.
    `rng` is unused by this shim but kept as a back-compat slot for analysis tools
    that run their own pure-Python bot phase with a bring-your-own RNG callable."""
    __slots__ = ('nodes', 'links', 'adj', 'mb', 'policy_rng', 'rng')


# --- topology bookkeeping: only re-push to C when the loaded board changes -----
_loaded = None


def _load(state):
    global _loaded
    if _loaded is not state:
        fastnw.set_topology(state)
        _loaded = state


def _arrays(state):
    return fastnw.board_arrays(state)


def make_game(seed):
    """Build a fresh seeded game (board built in C, bit-identical to the old port)."""
    g = fastnw.new_game(seed & M32)
    state = State()
    state.nodes = [Node(i, int(g['x'][i]), int(g['y'][i]),
                        FACTIONS[int(g['owner'][i])], int(g['strength'][i]))
                   for i in range(g['n'])]
    state.adj = g['adj']
    state.links = g['links']
    state.mb = g['mb']                                  # battle stream after the deal
    state.policy_rng = make_rng((seed ^ 0x9E3779B9) & M32)
    return state


def counts(state):
    c = dict.fromkeys(FACTIONS, 0)
    for n in state.nodes:
        c[n.owner] += 1
    return c


def check_winner(state):
    _load(state)
    owner, _ = _arrays(state)
    w = fastnw.check_winner(owner)
    return FACTIONS[w] if w >= 0 else None


def resolve_battle(state, from_id, to_id):
    """Resolve a battle on the real seeded stream; advance state.mb. Returns True
    iff the attacker captured (matches the old return)."""
    _load(state)
    owner, strength = _arrays(state)
    fastnw.use_mb32(state.mb)
    pre_owner_to = owner[to_id]
    fastnw.resolve_battle(owner, strength, from_id, to_id)
    state.mb = fastnw.get_mb32()
    fastnw.write_back(state, owner, strength)
    return owner[to_id] != pre_owner_to


def components_of(state, faction):
    """Connected components of `faction` (DFS over adjacency in id order)."""
    fi = FIDX[faction]
    owner = [FIDX[n.owner] for n in state.nodes]
    seen = set()
    comps = []
    for n in state.nodes:
        if owner[n.id] != fi or n.id in seen:
            continue
        comp = []
        stack = [n.id]
        seen.add(n.id)
        while stack:
            nid = stack.pop()
            comp.append(nid)
            for nb in state.adj[nid]:
                if nb not in seen and owner[nb] == fi:
                    seen.add(nb)
                    stack.append(nb)
        comps.append(comp)
    return comps


def reinforce(state, faction):
    _load(state)
    owner, strength = _arrays(state)
    fastnw.reinforce(owner, strength, FIDX[faction])
    fastnw.write_back(state, owner, strength)


def legal_moves(state, faction):
    fi = FIDX[faction]
    moves = []
    for n in state.nodes:
        if FIDX[n.owner] != fi or n.strength <= 1:
            continue
        for nb in state.adj[n.id]:
            if FIDX[state.nodes[nb].owner] != fi:
                moves.append((n.id, nb))
    return moves


def best_bot_move(state, faction):
    _load(state)
    owner, strength = _arrays(state)
    mv = fastnw.best_bot_move(owner, strength, FIDX[faction])
    if mv is None:
        return None
    frm, to = mv
    return (frm, to, state.nodes[frm].strength, state.nodes[to].strength)


def run_bot_turn(state, faction):
    _load(state)
    owner, strength = _arrays(state)
    fastnw.use_mb32(state.mb)
    fastnw.run_bot_turn(owner, strength, FIDX[faction])
    state.mb = fastnw.get_mb32()
    fastnw.write_back(state, owner, strength)


# --- policy harness (mirror of the old sim.js playGame, for eval/parity) -------
def play_game(policy, seed):
    state = make_game(seed)
    turns = 0
    while not check_winner(state) and turns < MAX_TURNS:
        turns += 1
        policy(state)
        if check_winner(state):
            break
        reinforce(state, HUMAN)
        if check_winner(state):
            break
        for bot in BOTS:
            run_bot_turn(state, bot)
            if check_winner(state):
                break
    winner = check_winner(state)
    return {'seed': seed, 'winner': winner, 'won': winner == HUMAN,
            'turns': turns, 'counts': counts(state)}


def safe_expand(state):
    """Attack the weakest strictly-weaker target, repeatedly (sim.js safeExpand)."""
    while True:
        moves = [m for m in legal_moves(state, HUMAN)
                 if state.nodes[m[0]].strength > state.nodes[m[1]].strength]
        if not moves:
            break
        best = moves[0]
        for m in moves:
            dt = state.nodes[m[1]].strength
            db = state.nodes[best[1]].strength
            if dt < db or (dt == db and state.nodes[m[0]].strength > state.nodes[best[0]].strength):
                best = m
        resolve_battle(state, best[0], best[1])


def random_all(state):
    """Attack random legal targets until none remain (uses the policy stream)."""
    moves = legal_moves(state, HUMAN)
    while moves:
        m = moves[int(state.policy_rng() * len(moves))]
        resolve_battle(state, m[0], m[1])
        moves = legal_moves(state, HUMAN)
