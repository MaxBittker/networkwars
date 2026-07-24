// Marshalling layer over the WASM build of fast_engine.c — the browser/worker (and
// the node parity gate) talk to the C engine through this. Direct port of
// solver/fastnw.py: it copies int32 arrays into the wasm heap, calls the exported
// C functions, and copies results back. It implements NO game rules itself — the C
// engine is the single source of truth for board-gen, the four bots, the
// fair-coin-attrition battle, reinforcement, and the C-UCT search.
//
// owner encoding: red=0, green=1, yellow=2, blue=3, purple=4 (= FACTIONS index).
// Two RNG streams in C: useMb32(seed) = the real seeded mulberry32 game stream;
// useSim(seed) = the private seed-free splitmix64 stream for search rollouts.
import Module from './fast_engine.js';

export const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
export const FIDX = Object.fromEntries(FACTIONS.map((f, i) => [f, i]));
export const MAXN = 64;

// Resolve `./fast_engine.js` against THIS module's URL so the worker (served from
// /public) and node (filesystem) both find it without a hard-coded path.
export async function loadEngine() {
  const M = await Module();
  return new Engine(M);
}

class Engine {
  constructor(M) {
    this.M = M;
    // persistent scratch buffers in the wasm heap (mirror fastnw.py's module bufs)
    this._owner = M._malloc(MAXN * 4);
    this._strength = M._malloc(MAXN * 4);
    this._x = M._malloc(MAXN * 4);
    this._y = M._malloc(MAXN * 4);
    this._adjOff = M._malloc((MAXN + 1) * 4);
    this._adjList = M._malloc(MAXN * 8 * 4);
    this._links = M._malloc(MAXN * 8 * 2 * 4);
    this._flips = M._malloc(4096 * 4);
    this._len = M._malloc(4);
    this._meta = M._malloc(5 * 4);
    this._acts = M._malloc(4096 * 4);
    this._visits = M._malloc(4096 * 4);
    this._q = M._malloc(4096 * 8);     // doubles
  }

  // ---- heap <-> Int32Array helpers ----
  _put(ptr, arr) {
    this.M.HEAP32.set(arr, ptr >> 2);
  }
  _get(ptr, n) {
    return this.M.HEAP32.slice(ptr >> 2, (ptr >> 2) + n);
  }
  _getBack(ptr, arr) {
    arr.set(this.M.HEAP32.subarray(ptr >> 2, (ptr >> 2) + arr.length));
  }

  // ---- topology ----
  setTopologyCsr(n, adj) {
    const off = new Int32Array(n + 1);
    const flat = [];
    for (let i = 0; i < n; i++) { off[i] = flat.length; for (const j of adj[i]) flat.push(j); }
    off[n] = flat.length;
    this._put(this._adjOff, off);
    this._put(this._adjList, Int32Array.from(flat));
    this.M._set_topology(n, this._adjOff, this._adjList);
    return n;
  }

  getAdj(n) {
    this.M._get_adj(this._adjOff, this._adjList);
    const off = this._get(this._adjOff, n + 1);
    const lst = this._get(this._adjList, off[n]);
    const adj = [];
    for (let i = 0; i < n; i++) adj.push(Array.from(lst.subarray(off[i], off[i + 1])));
    return adj;
  }

  getLinks() {
    const L = this.M._get_links(this._links);
    const raw = this._get(this._links, 2 * L);
    const links = [];
    for (let k = 0; k < L; k++) links.push([raw[2 * k], raw[2 * k + 1]]);
    return links;
  }

  // ---- board generation ----
  newGame(seed) {
    const n = this.M._new_game(seed >>> 0, this._owner, this._strength, this._x, this._y);
    return {
      n,
      owner: this._get(this._owner, n),
      strength: this._get(this._strength, n),
      x: this._get(this._x, n),
      y: this._get(this._y, n),
      adj: this.getAdj(n),
      links: this.getLinks(),
      mb: this.M._get_rng_mb32() >>> 0,
    };
  }

  // ---- rng ----
  useMb32(seed) { this.M._set_rng_mb32(seed >>> 0); this.M._use_mb32_rng(); }
  useSim(seed) { this.M._set_sim_seed(BigInt(seed)); this.M._use_sim_rng(); }
  getMb32() { return this.M._get_rng_mb32() >>> 0; }
  setMb32(v) { this.M._set_rng_mb32(v >>> 0); }

  // ---- pure-JS reads (no rules; mirror fastnw.py) ----
  counts(owner) {
    const c = [0, 0, 0, 0, 0];
    for (const v of owner) c[v]++;
    return c;
  }

  legalMoves(owner, strength, adj) {
    const moves = [];
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== 0 || strength[i] <= 1) continue;
      for (const j of adj[i]) if (owner[j] !== 0) moves.push([i, j]);
    }
    return moves;
  }

  // ---- primitives (mutate owner/strength in place, like the Python client) ----
  checkWinner(owner) {
    this._put(this._owner, owner);
    return this.M._ext_check_winner(this._owner);
  }

  // Bot-turn cursor (mirrors the real game's OpponentAI loop): begin() snapshots
  // + sorts the faction's islands strongest-first, next() yields one attack at a
  // time — after a capture the bot continues with the stack it just moved. Call
  // next() only with the previous attack already resolved.
  botTurnBegin(owner, strength, faction) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    const st = this.M._malloc((MAXN + 3) * 4);
    this.M._bot_turn_begin(this._owner, this._strength, faction, st);
    return st;
  }

  // next attack as [frm, to], or null when the faction's attacks are done (then
  // free the cursor with botTurnEnd).
  botTurnNext(owner, strength, faction, st) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    let r = this.M._bot_turn_next(this._owner, this._strength, faction, st);
    if (r === 0) return null;
    r -= 1;
    return [r >> 8, r & 0xFF];
  }

  botTurnEnd(st) { this.M._free(st); }

  attackLogged(owner, strength, frm, to) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    this.M._resolve_battle_logged(this._owner, this._strength, frm, to,
      this._flips, this._len, this._meta);
    this._getBack(this._owner, owner);
    this._getBack(this._strength, strength);
    const nflips = this.M.HEAP32[this._len >> 2];
    const fbuf = this._get(this._flips, nflips);
    const flips = Array.from(fbuf, (v) => (v ? 'd' : 'a'));
    const m = this._get(this._meta, 5);
    const meta = {
      captured: !!m[0], fromStart: m[1], toStart: m[2],
      fromStrength: m[3], toStrength: m[4],
    };
    return { flips, meta };
  }

  reinforce(owner, strength, faction) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    this.M._ext_reinforce(this._owner, this._strength, faction);
    this._getBack(this._owner, owner);
    this._getBack(this._strength, strength);
  }

  // ---- sweep-up (mop-up policy + its certificate; see fast_engine.c) ----
  // The rule the sweep plays, straight from C — the pages must not keep their own
  // copy, or the policy that gets certified stops being the policy that plays.
  sweepMove(owner, strength) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    const mv = this.M._sweep_best_move(this._owner, this._strength);
    return mv < 0 ? null : { from: mv >> 8, to: mv & 0xFF };
  }

  // Plays that policy to the end `trials` times on the private sim stream (the real
  // dice are untouched) and returns how many were LOST, giving up once that passes
  // maxLosses. Pass test: <= maxLosses. Costs about one search rollout per trial.
  sweepCertify(owner, strength, turns, trials, maxLosses = 0) {
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    return this.M._sweep_certify(this._owner, this._strength, turns, trials, maxLosses);
  }

  // ---- search ----
  // Always rolls out on the private sim stream (seed it with useSim() first), never
  // the real mb32 game dice, so a preceding real-game battle can't leak into search.
  // `sims` is the floor; `maxSims` (default == sims => fixed budget) the ceiling.
  // maxSims > sims runs adaptively: keeps searching while the top two root moves
  // stay close, stops once the leader is uncatchable (move-identical to full).
  uctSearch(owner, strength, turns, sims, cPuct = 2.5, nroll = 1, maxSims = null) {
    if (maxSims == null) maxSims = sims;
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    this.M._use_sim_rng();
    const nc = this.M._uct_search(this._owner, this._strength, turns, sims, maxSims, cPuct, nroll,
      this._acts, this._visits, this._q);
    if (nc < 0) throw new Error('uct_search pool alloc failed');
    const acts = this._get(this._acts, nc);
    const visits = this._get(this._visits, nc);
    const q = this.M.HEAPF64.slice(this._q >> 3, (this._q >> 3) + nc);
    return { acts, visits, q };
  }

  // ---- streaming search (persistent tree): begin once, then step/report in a
  // loop to visualize the root stats converging. Runs to the SAME terminal state
  // as uctSearch (bit-identical), just observed in chunks. Seed sim with useSim().
  uctBegin(owner, strength, turns, sims, cPuct = 2.5, nroll = 1, maxSims = null) {
    if (maxSims == null) maxSims = sims;
    this._put(this._owner, owner);
    this._put(this._strength, strength);
    this.M._use_sim_rng();
    return this.M._uct_begin(this._owner, this._strength, turns, sims, maxSims, cPuct, nroll);
  }
  // Optional value-based early stop (off until set): settle once the leading move
  // has >= minVis visits AND its win-prob is decisive (<=lo or >=hi) or beats the
  // runner-up by >=gap. Verified offline: ~3x fewer sims/move, no winrate change.
  setValueStop(lo, hi, gap, minVis) { this.M._uct_set_value_stop(lo, hi, gap, minVis | 0); }
  // Grading mode: accurate comparison ACROSS root moves (root min-visit floor, no
  // dominance early-stops, second-half Q readout) instead of fastest best-move pick.
  // 0 = off (default, bit-identical search), 1 = on. STICKY — callers must reset.
  setGrade(mode) { this.M._uct_set_grade(mode | 0); }

  // run up to `budget` more sims; returns true when the search is finished.
  uctStep(budget) { return this.M._uct_step(budget | 0) !== 0; }
  uctSimsDone() { return this.M._uct_sims_done(); }
  // read current root children (acts/visits/q) without disturbing the tree.
  uctReport() {
    const nc = this.M._uct_report(this._acts, this._visits, this._q);
    const acts = this._get(this._acts, nc);
    const visits = this._get(this._visits, nc);
    const q = this.M.HEAPF64.slice(this._q >> 3, (this._q >> 3) + nc);
    return { acts, visits, q };
  }
}
