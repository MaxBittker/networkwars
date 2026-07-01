"""Thin Python client over fast_engine.so — the C engine is the single source of
truth for all game rules, board generation, and search. This module just marshals
numpy int32 arrays in and out; it implements no rules itself.

Board state is (owner, strength) int32 arrays in node-id order. owner encoding:
red=0, green=1, yellow=2, blue=3, purple=4 (= FACTIONS index). The C functions
mutate the arrays in place. Topology (adjacency) is global in C: new_game() builds
it, or set_topology()/set_topology_csr() inject one for an externally-built board.

Two RNG streams in C: use_mb32(seed) = the real seeded mulberry32 game stream
(new_game seeds it); use_sim(seed) = the private seed-free stream for search.
"""
import ctypes
import os

import numpy as np

FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple']
FIDX = {f: i for i, f in enumerate(FACTIONS)}
MAXN = 64

_SO = os.environ.get('NW_ENGINE_SO') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'fast_engine.so')
_lib = ctypes.CDLL(_SO)

_i32p = ctypes.POINTER(ctypes.c_int)
_dblp = ctypes.POINTER(ctypes.c_double)

_lib.set_topology.argtypes = [ctypes.c_int, _i32p, _i32p]
_lib.set_rng_mb32.argtypes = [ctypes.c_uint32]
_lib.get_rng_mb32.restype = ctypes.c_uint32
_lib.set_sim_seed.argtypes = [ctypes.c_uint64]
_lib.use_mb32_rng.argtypes = []
_lib.use_sim_rng.argtypes = []
_lib.new_game.argtypes = [ctypes.c_uint32, _i32p, _i32p, _i32p, _i32p]
_lib.new_game.restype = ctypes.c_int
_lib.get_adj.argtypes = [_i32p, _i32p]
_lib.get_adj.restype = ctypes.c_int
_lib.get_links.argtypes = [_i32p]
_lib.get_links.restype = ctypes.c_int
_lib.rollout.argtypes = [_i32p, _i32p, ctypes.c_int]
_lib.rollout.restype = ctypes.c_int
_lib.end_turn.argtypes = [_i32p, _i32p]
_lib.resolve_battle_logged.argtypes = [_i32p, _i32p, ctypes.c_int, ctypes.c_int,
                                       _i32p, _i32p, _i32p]
_lib.uct_search.argtypes = [_i32p, _i32p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                            ctypes.c_double, ctypes.c_int, _i32p, _i32p, _dblp]
_lib.uct_search.restype = ctypes.c_int
_lib.ext_resolve_battle.argtypes = [_i32p, _i32p, ctypes.c_int, ctypes.c_int]
_lib.ext_reinforce.argtypes = [_i32p, _i32p, ctypes.c_int]
_lib.ext_run_bot_turn.argtypes = [_i32p, _i32p, ctypes.c_int]
_lib.ext_best_bot_move.argtypes = [_i32p, _i32p, ctypes.c_int]
_lib.ext_best_bot_move.restype = ctypes.c_int
_lib.ext_check_winner.argtypes = [_i32p]
_lib.ext_check_winner.restype = ctypes.c_int
_lib.uct_set_value_stop.argtypes = [ctypes.c_double, ctypes.c_double,
                                    ctypes.c_double, ctypes.c_int]
_lib.uct_set_deepthink.argtypes = [ctypes.c_double, ctypes.c_int, ctypes.c_double]
_lib.uct_sims_done.restype = ctypes.c_int
_lib.use_hybrid_battle.argtypes = [ctypes.c_int]
_lib.get_hybrid_battle.restype = ctypes.c_int


def use_hybrid_battle(on=True):
    """Toggle the OPTIONAL 'hybrid loop + hinge remnant' battle model (OFF by default;
    the shipped closed-form single-shot + survivor planes otherwise). The hybrid model
    resolves each fight as single-casualty proportional attrition (outcome + occupier
    emerge) with a hinge repel remnant — the historically-plausible original iOS loop
    (see solver/ITERATED_BATTLE_MODELS.md, model A). Affects the search's rollout world."""
    _lib.use_hybrid_battle(1 if on else 0)


def hybrid_battle_on():
    return bool(_lib.get_hybrid_battle())


# opt-in via env so offline eval (par_eval/fmcts) and the live driver both pick it up
if os.environ.get('NW_HYBRID_BATTLE') == '1':
    use_hybrid_battle(True)


def sims_done():
    """Sims actually spent by the most recent uct_search (for adaptive accounting)."""
    return int(_lib.uct_sims_done())


def set_value_stop(lo=-1.0, hi=2.0, gap=2.0, min_vis=1 << 30):
    """Enable/configure the optional value-based early stop (default args = OFF).
    Settle once the leading move has >= min_vis visits AND its RED win-prob is
    decisive (<= lo or >= hi) or beats the runner-up by >= gap."""
    _lib.uct_set_value_stop(float(lo), float(hi), float(gap), int(min_vis))


def set_deepthink(ratio=0.0, min_vis=1 << 30, behind=2.0):
    """Enable/configure the 'deep-think' early stop (default = OFF). Use with
    uct_search(sims=floor, max_sims=BIG ceiling): keep searching toward the ceiling
    ONLY while the leading root move is contested (b1 < ratio*b2) AND red is behind
    (leader win-prob < `behind`); otherwise stop at the floor (cheap). So compute is
    spent on comeback positions (contested + behind) and nowhere else. behind=2.0
    disables the behind-gate (pure move-dominance). ratio=0 disables entirely."""
    _lib.uct_set_deepthink(float(ratio), int(min_vis), float(behind))


def _p(a):
    return a.ctypes.data_as(_i32p)


# ---- topology ---------------------------------------------------------------
def set_topology_csr(n, adj):
    """Inject adjacency from a list-of-lists `adj` (for externally-built boards)."""
    adj_off = np.zeros(n + 1, dtype=np.int32)
    flat = []
    for i in range(n):
        adj_off[i] = len(flat)
        flat.extend(adj[i])
    adj_off[n] = len(flat)
    adj_list = np.asarray(flat, dtype=np.int32)
    _lib.set_topology(n, _p(adj_off), _p(adj_list))
    return n


def set_topology(state):
    """Push the adjacency of a Python state (state.adj) into the C engine."""
    return set_topology_csr(len(state.nodes), state.adj)


def get_adj(n):
    """Read the current C adjacency back as a list-of-lists of length n."""
    off = np.zeros(n + 1, dtype=np.int32)
    lst = np.zeros(MAXN * 8, dtype=np.int32)
    _lib.get_adj(_p(off), _p(lst))
    return [[int(v) for v in lst[off[i]:off[i + 1]]] for i in range(n)]


def get_links():
    out = np.zeros(MAXN * 8, dtype=np.int32)
    L = _lib.get_links(_p(out))
    return [[int(out[2 * k]), int(out[2 * k + 1])] for k in range(L)]


# ---- board generation -------------------------------------------------------
def new_game(seed):
    """Build a fresh seeded board in C (also sets topology + seeds mb32). Returns a
    dict: owner, strength (np int32 len N), x, y (np int32 len N), adj (list-of-lists),
    links (list of [a,b]), n, mb (mulberry32 stream position after the deal)."""
    owner = np.zeros(MAXN, dtype=np.int32)
    strength = np.zeros(MAXN, dtype=np.int32)
    x = np.zeros(MAXN, dtype=np.int32)
    y = np.zeros(MAXN, dtype=np.int32)
    n = _lib.new_game(seed, _p(owner), _p(strength), _p(x), _p(y))
    return {
        'n': n, 'owner': owner[:n].copy(), 'strength': strength[:n].copy(),
        'x': x[:n].copy(), 'y': y[:n].copy(),
        'adj': get_adj(n), 'links': get_links(), 'mb': int(_lib.get_rng_mb32()),
    }


# ---- rng --------------------------------------------------------------------
def use_mb32(seed):
    """Switch C to the real seeded mulberry32 stream (real-game dice)."""
    _lib.set_rng_mb32(seed & 0xFFFFFFFF)
    _lib.use_mb32_rng()


def use_sim(seed):
    """Switch C to the private seed-free splitmix64 stream (search dice)."""
    _lib.set_sim_seed(seed)
    _lib.use_sim_rng()


def get_mb32():
    return int(_lib.get_rng_mb32())


def set_mb32(v):
    _lib.set_rng_mb32(v & 0xFFFFFFFF)


# ---- primitives (operate on owner/strength arrays in place) -----------------
def counts(owner):
    c = [0] * 5
    for v in owner:
        c[int(v)] += 1
    return c


def check_winner(owner):
    """Return faction index (0..4) of the winner, or -1 if none."""
    return _lib.ext_check_winner(_p(owner))


def legal_moves(owner, strength, adj):
    """All legal RED (owner 0) attacks: from an owned node (strength>1) into an
    enemy neighbor. Pure read of the arrays + adjacency."""
    moves = []
    for i in range(len(owner)):
        if owner[i] != 0 or strength[i] <= 1:
            continue
        for j in adj[i]:
            if owner[j] != 0:
                moves.append((i, j))
    return moves


def best_bot_move(owner, strength, faction):
    """Return (frm, to) for the faction's greedy bot move, or None."""
    r = _lib.ext_best_bot_move(_p(owner), _p(strength), faction)
    if r == 0:
        return None
    r -= 1
    return (r >> 8, r & 0xFF)


def resolve_battle(owner, strength, frm, to):
    """Resolve one battle (uses the active RNG). Mutates arrays in place."""
    _lib.ext_resolve_battle(_p(owner), _p(strength), frm, to)


_flips_buf = np.zeros(4096, dtype=np.int32)
_len_buf = np.zeros(1, dtype=np.int32)
_meta_buf = np.zeros(5, dtype=np.int32)


def attack_logged(owner, strength, frm, to):
    """Resolve one battle and return (flips, meta) for the UI animation. flips is a
    list of 'd'/'a' (defender/attacker lost a unit, in order). meta is a dict with
    captured, fromStart, toStart, fromStrength, toStrength. Uses the active RNG."""
    _lib.resolve_battle_logged(_p(owner), _p(strength), frm, to,
                               _p(_flips_buf), _p(_len_buf), _p(_meta_buf))
    nflips = int(_len_buf[0])
    flips = ['d' if _flips_buf[i] else 'a' for i in range(nflips)]
    m = _meta_buf
    meta = {'captured': bool(m[0]), 'fromStart': int(m[1]), 'toStart': int(m[2]),
            'fromStrength': int(m[3]), 'toStrength': int(m[4])}
    return flips, meta


def reinforce(owner, strength, faction):
    _lib.ext_reinforce(_p(owner), _p(strength), faction)


def run_bot_turn(owner, strength, faction):
    _lib.ext_run_bot_turn(_p(owner), _p(strength), faction)


def end_turn(owner, strength):
    """RED reinforce + all four bot turns. Uses the active RNG."""
    _lib.end_turn(_p(owner), _p(strength))


def rollout(owner, strength, turns):
    return _lib.rollout(_p(owner), _p(strength), turns)


# ---- search -----------------------------------------------------------------
_out_acts = np.zeros(4096, dtype=np.int32)
_out_visits = np.zeros(4096, dtype=np.int32)
_out_q = np.zeros(4096, dtype=np.float64)


def uct_search(owner, strength, turns, sims, c_puct=2.5, nroll=1, return_q=False,
               max_sims=None):
    """Run the C UCT search. Returns (acts, visits) for the root's legal children
    (acts are frm<<8|to, or -1 for END_TURN). With return_q, also returns per-child
    Q (the backed-up RED win-prob estimate = winexp).

    `sims` is the floor (min budget); `max_sims` (default == sims, i.e. fixed
    budget) is the ceiling. When max_sims > sims the search runs adaptively: it
    keeps going past `sims` while the top two root moves stay close and stops once
    the leader is uncatchable (move-identical to running the full ceiling).

    Always rolls out on the private sim stream (never the real mb32 game dice), so a
    preceding real-game battle can't leak into the search. Seed it with use_sim()."""
    if max_sims is None:
        max_sims = sims
    _lib.use_sim_rng()
    nc = _lib.uct_search(_p(owner), _p(strength), turns, sims, max_sims, c_puct, nroll,
                         _p(_out_acts), _p(_out_visits),
                         _out_q.ctypes.data_as(_dblp))
    if nc < 0:
        raise RuntimeError("uct_search pool alloc failed")
    if return_q:
        return _out_acts[:nc].copy(), _out_visits[:nc].copy(), _out_q[:nc].copy()
    return _out_acts[:nc].copy(), _out_visits[:nc].copy()


# ---- back-compat helpers for the network_wars shim --------------------------
def board_arrays(state):
    """Extract (owner, strength) int32 arrays from a Python state, node-id order."""
    n = len(state.nodes)
    owner = np.empty(n, dtype=np.int32)
    strength = np.empty(n, dtype=np.int32)
    for nd in state.nodes:
        owner[nd.id] = FIDX[nd.owner]
        strength[nd.id] = nd.strength
    return owner, strength


def write_back(state, owner, strength):
    """Copy C arrays back into a Python state's Node objects."""
    for nd in state.nodes:
        nd.owner = FACTIONS[owner[nd.id]]
        nd.strength = int(strength[nd.id])
