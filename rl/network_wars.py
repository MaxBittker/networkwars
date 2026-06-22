"""Network Wars — readable Python engine for the real iOS app (the source of truth).

This is the reference spec the C hot-path (fast_engine.c) is validated against
(validate_fast.py) and that fmcts.py uses to play the real seeded game while it
plans with the C UCT search. Topology (6x7 king-adjacency lattice), reinforcement,
and the four bots' targeting are game.js mechanics that were verified to match iOS.
Two things were re-calibrated from live play and intentionally DIVERGE from game.js:
  - DEAL: every faction starts with total strength exactly 20, drawn as one of 4
    fixed templates (IOS_DEAL_TEMPLATES) — not game.js's i.i.d. 50%->1/else-4-8.
  - BATTLE: power-ratio per-round dice (see _battle_q / rl/BATTLE_FUNCTION.md),
    not the legacy constant-p iterated Bernoulli.
See memories sim-vs-real-deal-imbalance and sim-vs-real-battle-mismatch.
"""

import math

FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple']
BOTS = ['green', 'yellow', 'blue', 'purple']
HUMAN = 'red'

GRID_ROWS = 7       # real iOS app uses a 6-wide x 7-tall grid (measured via mirror)
GRID_COLS = 6
TARGET_NODES = 30
WIN_NODES = 24
# Legacy iterated-Bernoulli constant (no longer used by resolve_battle).
ATTACKER_WIN_P = 0.60
# Fitted iOS battle = POWER-RATIO. Per round the attacker wins w.p.
#   q(a,d) = a^PR_K / (a^PR_K + PR_C0 * d^PR_K)
# (fit from ~3300 live battles; see rl/BATTLE_FUNCTION.md). This is what the live
# MCTS driver uses (fast_engine power-ratio) and what game.js/fast_engine.c carry.
# q is truncated to 1e-6 so JS (Math.pow) and Python (**) agree bit-for-bit.
PR_K = 0.62
PR_C0 = 0.93


def _battle_q(a, d):
    ak = a ** PR_K
    dk = d ** PR_K
    return math.floor(ak / (ak + PR_C0 * dk) * 1e6) / 1e6

MAX_TURNS = 300  # draw/loss cutoff

# Initial deal: the real iOS app gives EVERY faction a total strength of exactly 20,
# drawn as one of 4 fixed 6-node templates (frequencies measured over 96 live games;
# see memory sim-vs-real-deal-imbalance). This is the source of truth — it replaces
# game.js's i.i.d. (50%->1 else 4-8) deal, whose per-faction totals swung wildly
# (spread ~15 vs the real ~0), which was the main sim-vs-reality gap.
IOS_DEAL_TEMPLATES = [   # (6 per-faction strengths summing to 20, probability)
    ((1, 1, 1, 5, 6, 6), 0.385),
    ((1, 1, 1, 1, 8, 8), 0.327),
    ((1, 1, 4, 4, 5, 5), 0.222),
    ((1, 3, 4, 4, 4, 4), 0.066),
]


def _pick_ios_template(rng):
    """Weighted pick of a per-faction strength template using the seeded rng."""
    r = rng()
    acc = 0.0
    for tmpl, prob in IOS_DEAL_TEMPLATES:
        acc += prob
        if r < acc:
            return tmpl
    return IOS_DEAL_TEMPLATES[-1][0]

M32 = 0xFFFFFFFF


# --- seeded RNG (mulberry32, bit-identical to game.js) -----------------------
def make_rng(seed):
    s = seed & M32

    def rng():
        nonlocal s
        s = (s + 0x6D2B79F5) & M32
        t = ((s ^ (s >> 15)) * (s | 1)) & M32
        t = ((t + (((t ^ (t >> 7)) * (t | 61)) & M32)) ^ t) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rng


def shuffle(arr, rng):
    for i in range(len(arr) - 1, 0, -1):
        j = int(rng() * (i + 1))
        arr[i], arr[j] = arr[j], arr[i]
    return arr


# Cluster each faction into ~2-3 connected territories (line-for-line port of
# assignOwnership in game.js). Seeded territorial growth with scatter; consumes
# the RNG in the same order as JS.
OWNER_SEEDS = 1
OWNER_SCATTER = 0.6


def assign_ownership(nodes, adj, rng):
    n = len(nodes)
    ids = list(range(n))
    owner = [None] * n
    counts = {f: 0 for f in FACTIONS}
    pool = shuffle(list(ids), rng)
    p = 0
    for _ in range(OWNER_SEEDS):
        for f in FACTIONS:
            owner[pool[p]] = f
            counts[f] += 1
            p += 1
    guard = 0
    while any(counts[f] < 6 for f in FACTIONS) and guard < 10000:
        guard += 1
        for f in shuffle(list(FACTIONS), rng):
            if counts[f] >= 6:
                continue
            free = [i for i in ids if owner[i] is None]
            if rng() < OWNER_SCATTER:
                pick = free[int(rng() * len(free))]
            else:
                border = []
                for i in range(n):
                    if owner[i] != f:
                        continue
                    for nb in adj[i]:
                        if owner[nb] is None and nb not in border:
                            border.append(nb)
                if border:
                    pick = border[int(rng() * len(border))]
                else:
                    pick = free[int(rng() * len(free))]
            owner[pick] = f
            counts[f] += 1
    for i, nd in enumerate(nodes):
        nd.owner = owner[i]


# --- board generation ---------------------------------------------------------
class Node:
    __slots__ = ('id', 'x', 'y', 'owner', 'strength')

    def __init__(self, id, x, y, owner, strength):
        self.id, self.x, self.y = id, x, y
        self.owner, self.strength = owner, strength


class State:
    __slots__ = ('nodes', 'links', 'adj', 'rng', 'policy_rng')


def build_board(rng):
    def gid_at(r, c):
        return r * GRID_COLS + c

    cell_count = GRID_ROWS * GRID_COLS

    # grid adjacency; lists preserve the JS Set insertion order
    grid_adj = [[] for _ in range(cell_count)]
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            a = gid_at(r, c)

            def link(b):
                grid_adj[a].append(b)
                grid_adj[b].append(a)

            if c + 1 < GRID_COLS:
                link(gid_at(r, c + 1))
            if r + 1 < GRID_ROWS:
                link(gid_at(r + 1, c))
                if c - 1 >= 0:
                    link(gid_at(r + 1, c - 1))
                if c + 1 < GRID_COLS:
                    link(gid_at(r + 1, c + 1))

    # ordered set of alive cells (dict keys keep insertion order like a JS Set)
    alive = dict.fromkeys(range(cell_count))

    def still_connected(excluded):
        start = next((g for g in alive if g != excluded), None)
        if start is None:
            return False
        seen = {start}
        stack = [start]
        while stack:
            g = stack.pop()
            for nb in grid_adj[g]:
                if nb != excluded and nb in alive and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        return len(seen) == len(alive) - 1

    while len(alive) > TARGET_NODES:
        candidates = shuffle(list(alive), rng)
        removed = False
        for gid in candidates:
            if still_connected(gid):
                del alive[gid]
                removed = True
                break
        if not removed:
            break

    survivors = sorted(alive)
    new_id = {g: i for i, g in enumerate(survivors)}
    nodes = [Node(i, g % GRID_COLS, g // GRID_COLS, None, 1) for i, g in enumerate(survivors)]

    link_set = set()
    links = []
    for g in survivors:
        for nb in grid_adj[g]:
            if nb not in alive:
                continue
            a, b = new_id[g], new_id[nb]
            key = (a, b) if a < b else (b, a)
            if key in link_set:
                continue
            link_set.add(key)
            links.append([min(a, b), max(a, b)])

    adj = [[] for _ in nodes]
    for a, b in links:
        adj[a].append(b)
        adj[b].append(a)

    # ownership: clustered territorial growth (match game.js assignOwnership),
    # not a uniform scatter.
    assign_ownership(nodes, adj, rng)

    # iOS deal: each faction's 6 nodes get one of 4 fixed templates (each sums to
    # 20), shuffled across that faction's nodes -> every faction starts with equal
    # total strength (the real spread~0 balance).
    for f in FACTIONS:
        owned = [n for n in nodes if n.owner == f]
        vals = list(_pick_ios_template(rng))
        shuffle(vals, rng)
        for n, s in zip(owned, vals):
            n.strength = s

    state = State()
    state.nodes, state.links, state.adj = nodes, links, adj
    return state


def make_game(seed):
    rng = make_rng(seed & M32)
    state = build_board(rng)
    state.rng = rng
    state.policy_rng = make_rng((seed ^ 0x9E3779B9) & M32)
    return state


# --- core mechanics -----------------------------------------------------------
def counts(state):
    c = dict.fromkeys(FACTIONS, 0)
    for n in state.nodes:
        c[n.owner] += 1
    return c


def check_winner(state):
    c = counts(state)
    for f in FACTIONS:
        if c[f] >= WIN_NODES:
            return f
    alive = [f for f in FACTIONS if c[f] > 0]
    if len(alive) == 1:
        return alive[0]
    return None


def resolve_battle(state, from_id, to_id):
    frm = state.nodes[from_id]
    to = state.nodes[to_id]
    a = frm.strength
    d = to.strength
    rng = state.rng
    a0, d0 = a, d
    while a > 1 and d > 0:
        if rng() < _battle_q(a, d):
            d -= 1
        else:
            a -= 1
    if d == 0 and a >= 2:
        # capture: attacker still has a unit to occupy. Node gets a-1 (>= 1),
        # source keeps its garrison of 1. A capture can NEVER leave the node at 0.
        to.owner = frm.owner
        to.strength = a - 1
        frm.strength = 1
        return True
    # repelled: source garrisons at 1; the defender was gutted by the full attacking
    # force -> remnant max(0, d0 - a0 + 1) (can be 0 — the legal "fail and leave 0").
    frm.strength = 1
    rem = d0 - a0 + 1
    to.strength = rem if rem > 0 else 0
    return False


def components_of(state, faction):
    seen = set()
    comps = []
    for n in state.nodes:
        if n.owner != faction or n.id in seen:
            continue
        comp = []
        stack = [n.id]
        seen.add(n.id)
        while stack:
            nid = stack.pop()
            comp.append(nid)
            for nb in state.adj[nid]:
                if nb not in seen and state.nodes[nb].owner == faction:
                    seen.add(nb)
                    stack.append(nb)
        comps.append(comp)
    return comps


def reinforce(state, faction):
    comps = components_of(state, faction)
    if not comps:
        return None
    largest = comps[0]
    for comp in comps:
        if len(comp) > len(largest):
            largest = comp
    n_total = len(largest)
    border = sorted(
        nid for nid in largest
        if any(state.nodes[nb].owner != faction for nb in state.adj[nid])
    )
    if not border:
        return None
    for i in range(n_total):
        state.nodes[border[i % len(border)]].strength += 1
    return n_total


def legal_moves(state, faction):
    moves = []
    for n in state.nodes:
        if n.owner != faction or n.strength <= 1:
            continue
        for nb in state.adj[n.id]:
            if state.nodes[nb].owner != faction:
                moves.append((n.id, nb))
    return moves


def best_bot_move(state, faction):
    best = None
    for n in state.nodes:
        if n.owner != faction or n.strength <= 1:
            continue
        for nb in state.adj[n.id]:
            t = state.nodes[nb]
            if t.owner == faction or t.strength >= n.strength:
                continue
            cand = (n.id, nb, n.strength, t.strength)
            if (best is None
                    or cand[3] < best[3]
                    or (cand[3] == best[3] and cand[2] > best[2])
                    or (cand[3] == best[3] and cand[2] == best[2] and cand[0] < best[0])
                    or (cand[3] == best[3] and cand[2] == best[2] and cand[0] == best[0] and cand[1] < best[1])):
                best = cand
    return best


def run_bot_turn(state, faction):
    if counts(state)[faction] == 0:
        return
    guard = 0
    while guard < 1000:
        guard += 1
        move = best_bot_move(state, faction)
        if move is None:
            break
        resolve_battle(state, move[0], move[1])
        if check_winner(state):
            return
    reinforce(state, faction)


# --- policy harness (mirror of sim.js playGame, for verification/eval) --------
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
    """Port of sim.js safeExpand: attack weakest strictly-weaker target."""
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
    """Port of sim.js randomAll (uses the policy RNG stream)."""
    moves = legal_moves(state, HUMAN)
    while moves:
        m = moves[int(state.policy_rng() * len(moves))]
        resolve_battle(state, m[0], m[1])
        moves = legal_moves(state, HUMAN)
