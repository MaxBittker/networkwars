"""ctypes wrapper around fast_engine.so (the C hot path).

Topology is set once per game with set_topology(state). Board state is passed as
int32 numpy arrays (owner, strength); the C functions mutate them in place.
owner encoding: red=0, green=1, yellow=2, blue=3, purple=4 (= FACTIONS index).
"""
import ctypes
import os

import numpy as np

import network_wars as nw

_SO = os.environ.get('NW_ENGINE_SO') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'fast_engine.so')
_lib = ctypes.CDLL(_SO)

_i32p = ctypes.POINTER(ctypes.c_int)

_lib.set_topology.argtypes = [ctypes.c_int, _i32p, _i32p]
_lib.set_rng_mb32.argtypes = [ctypes.c_uint32]
_lib.set_sim_seed.argtypes = [ctypes.c_uint64]
_lib.use_mb32_rng.argtypes = []
_lib.use_sim_rng.argtypes = []
_lib.rollout.argtypes = [_i32p, _i32p, ctypes.c_int]
_lib.rollout.restype = ctypes.c_int
_lib.rollout_avg.argtypes = [_i32p, _i32p, ctypes.c_int, ctypes.c_int]
_lib.rollout_avg.restype = ctypes.c_double
_lib.end_turn.argtypes = [_i32p, _i32p]
_dblp = ctypes.POINTER(ctypes.c_double)
_lib.uct_search.argtypes = [_i32p, _i32p, ctypes.c_int, ctypes.c_int,
                            ctypes.c_double, ctypes.c_int, _dblp, _i32p, _i32p,
                            _dblp]
_lib.uct_search.restype = ctypes.c_int
_lib.ext_resolve_battle.argtypes = [_i32p, _i32p, ctypes.c_int, ctypes.c_int]
_lib.ext_reinforce.argtypes = [_i32p, _i32p, ctypes.c_int]
_lib.ext_run_bot_turn.argtypes = [_i32p, _i32p, ctypes.c_int]
_lib.ext_best_bot_move.argtypes = [_i32p, _i32p, ctypes.c_int]
_lib.ext_best_bot_move.restype = ctypes.c_int
_lib.ext_check_winner.argtypes = [_i32p]
_lib.ext_check_winner.restype = ctypes.c_int

FIDX = {f: i for i, f in enumerate(nw.FACTIONS)}


def _p(a):
    return a.ctypes.data_as(_i32p)


def set_topology(state):
    """Push the (fixed) adjacency of `state` into the C engine. Call once per game."""
    n = len(state.nodes)
    adj_off = np.zeros(n + 1, dtype=np.int32)
    flat = []
    for i in range(n):
        adj_off[i] = len(flat)
        flat.extend(state.adj[i])
    adj_off[n] = len(flat)
    adj_list = np.asarray(flat, dtype=np.int32)
    _lib.set_topology(n, _p(adj_off), _p(adj_list))
    return n


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
    """Copy C arrays back into a Python state (for validation)."""
    for nd in state.nodes:
        nd.owner = nw.FACTIONS[owner[nd.id]]
        nd.strength = int(strength[nd.id])


def rollout(owner, strength, turns):
    return _lib.rollout(_p(owner), _p(strength), turns)


def rollout_avg(owner, strength, turns, nroll):
    return _lib.rollout_avg(_p(owner), _p(strength), turns, nroll)


def end_turn(owner, strength):
    _lib.end_turn(_p(owner), _p(strength))


PRI_END = 16192
_out_acts = np.zeros(4096, dtype=np.int32)
_out_visits = np.zeros(4096, dtype=np.int32)
_out_q = np.zeros(4096, dtype=np.float64)


def uct_search(owner, strength, turns, sims, c_puct=1.5, nroll=1, root_pri=None,
               return_q=False):
    """Run the C UCT search. Returns (acts, visits) arrays for the root's legal
    children. acts are frm<<8|to, or -1 for END_TURN. root_pri optional dense
    np.float64 array length 16193 (index frm<<8|to, PRI_END for end).
    If return_q, also returns per-child Q (backed-up RED win-prob estimate)."""
    prip = root_pri.ctypes.data_as(_dblp) if root_pri is not None else None
    nc = _lib.uct_search(_p(owner), _p(strength), turns, sims, c_puct, nroll,
                         prip, _p(_out_acts), _p(_out_visits),
                         _out_q.ctypes.data_as(_dblp))
    if nc < 0:
        raise RuntimeError("uct_search pool alloc failed")
    if return_q:
        return _out_acts[:nc].copy(), _out_visits[:nc].copy(), _out_q[:nc].copy()
    return _out_acts[:nc].copy(), _out_visits[:nc].copy()


_lib.set_red_rollout_policy.argtypes = [ctypes.c_int]
_lib.set_ranked_weights.argtypes = [_dblp]
_lib.set_heur_priors.argtypes = [ctypes.c_int, ctypes.c_double]


def set_heur_priors(on, beta=0.02):
    """Use softmax(beta*ranked_score) as PUCT priors at every node."""
    _lib.set_heur_priors(1 if on else 0, beta)


_lib.set_roll_temp.argtypes = [ctypes.c_double]
_lib.set_ensemble.argtypes = [_dblp, ctypes.c_int]
_lib.set_safety_params.argtypes = [ctypes.c_double, ctypes.c_double]


def set_safety_params(sw, rg):
    """Safety-aware rollout (policy=2): weights on threat-reduction and capture."""
    _lib.set_safety_params(sw, rg)


def set_roll_temp(t):
    """Rollout policy temperature: 0 = deterministic argmax, >0 = softmax sample."""
    _lib.set_roll_temp(t)


def set_ensemble(wlist):
    """wlist: list of 13-element weight vectors; rollouts rotate through them.
    Pass [] to disable."""
    if not wlist:
        _lib.set_ensemble(np.zeros(1, dtype=np.float64).ctypes.data_as(_dblp), 0)
        return
    flat = np.asarray([x for w in wlist for x in w], dtype=np.float64)
    _lib.set_ensemble(flat.ctypes.data_as(_dblp), len(wlist))


def set_red_rollout_policy(p):
    """0 = greedy bot-style rollout, 1 = ranked C4 rollout (default)."""
    _lib.set_red_rollout_policy(p)


_lib.set_value_weights.argtypes = [_dblp]
_lib.set_leaf_trunc.argtypes = [ctypes.c_int]


def set_value_weights(w):
    """w: 8 logistic weights for the fitted static leaf value (features:
    [bias, red_n, red_n-maxEn, red_n-avgEn, redS-maxES, red_big, fracture, turns]).
    Enables truncated-rollout heuristic leaf when combined with set_leaf_trunc(k>=0)."""
    arr = np.asarray(w, dtype=np.float64)
    assert arr.size == 8
    _lib.set_value_weights(arr.ctypes.data_as(_dblp))


def set_leaf_trunc(k):
    """Leaf eval: -1 = full rollout to terminal (default); k>=0 = roll k red-turn
    cycles then return the fitted heuristic value. Requires set_value_weights first."""
    _lib.set_leaf_trunc(int(k))


def set_ranked_weights(w):
    """w: float64 array of 13 [capture,weakTarget,margin,source,redAdj,merge,
    largestTouch,enemyCount,eliminate,exposure,lowChancePenalty,
    strongTargetPenalty,threshold]."""
    arr = np.asarray(w, dtype=np.float64)
    _lib.set_ranked_weights(arr.ctypes.data_as(_dblp))


def use_mb32(seed):
    _lib.set_rng_mb32(seed)
    _lib.use_mb32_rng()


def use_sim(seed):
    _lib.set_sim_seed(seed)
    _lib.use_sim_rng()
