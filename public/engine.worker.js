// In-browser game server — the SAME C engine the solver uses, compiled to WASM and
// run in a Web Worker so the 6000-sim C-UCT search never blocks the UI. Direct port
// of solver/server.py: it holds game state and sequences C-engine calls, building
// the exact same view/log/events/search JSON that index.html already speaks. No game
// logic lives here — board-gen, the four bots, the power-ratio battle, reinforcement
// and the search are all in fast_engine.c (via fastnw.js). The frontend is now fully
// self-contained: no HTTP API, no Python.
import { loadEngine, FACTIONS, FIDX } from './fastnw.js';

let E = null;                 // the WASM engine (loaded once)
const GAMES = {};
let nextId = 0;
const newId = () => String(++nextId);

// Make the C engine's global topology match game g before any mutation (server._select).
function select(g) { E.setTopologyCsr(g.owner.length, g.adj); }

function updateWinner(g) {
  const c = E.counts(g.owner);
  let w = -1;
  for (let f = 0; f < 5; f++) if (c[f] >= 24) w = f;
  const alive = [];
  for (let f = 0; f < 5; f++) if (c[f] > 0) alive.push(f);
  if (alive.length === 1) w = alive[0];
  if (w >= 0) { g.over = true; g.winner = FACTIONS[w]; g.youWon = (w === 0); return; }
  // RED wiped out: attacks can only launch FROM an owned node, so at 0 nodes red can
  // never move again and the game is already lost — no bot needs to reach 24 to prove
  // it. Call it now, instead of leaving the player with no legal moves, forced to End
  // Turn while the bots race to the win. (`winner` stays null: which bot eventually
  // takes it is undecided, and no UI reads it.)
  if (c[0] === 0) { g.over = true; g.youWon = false; }
}

function view(g) {
  const n = g.owner.length;
  const nodes = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: i, x: g.x[i], y: g.y[i],
      owner: FACTIONS[g.owner[i]], strength: g.strength[i] });
  }
  const c = E.counts(g.owner);
  const counts = {};
  for (let f = 0; f < 5; f++) counts[FACTIONS[f]] = c[f];
  const legal = E.legalMoves(g.owner, g.strength, g.adj).map(([a, b]) => ({ from: a, to: b }));
  return { id: g.id, seed: g.seed, nodes, links: g.links, counts, turn: g.turn, legalMoves: legal,
    over: g.over, youWon: g.youWon, redResigned: g.redResigned, winner: g.winner };
}

function newGame(seed) {
  if (seed == null) seed = (Math.floor(Math.random() * 0x7fffffff) + 1);
  const d = E.newGame(seed);
  const g = { id: newId(), owner: d.owner, strength: d.strength, x: d.x, y: d.y,
    adj: d.adj, links: d.links, mb: d.mb, turn: 1, over: false, youWon: false,
    redResigned: false, winner: null, seed };
  GAMES[g.id] = g;
  return g;
}

// Start a game from an externally-parsed board (list of {id,x,y,owner,strength}).
// Adjacency = 8-connectivity over (x,y), matching the iOS-parse path in server.py.
function gameFromBoard(boardNodes, mbSeed) {
  const n = boardNodes.length;
  const owner = new Int32Array(n), strength = new Int32Array(n);
  const x = new Int32Array(n), y = new Int32Array(n);
  for (const nd of boardNodes) {
    owner[nd.id] = FIDX[nd.owner];
    strength[nd.id] = nd.strength;
    x[nd.id] = nd.x; y[nd.id] = nd.y;
  }
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (Math.abs(x[i] - x[j]) <= 1 && Math.abs(y[i] - y[j]) <= 1) { adj[i].push(j); adj[j].push(i); }
  E.setTopologyCsr(n, adj);
  const links = E.getLinks();
  const g = { id: newId(), owner, strength, x, y, adj, links,
    mb: (mbSeed != null ? mbSeed : (Math.floor(Math.random() * 0x7fffffff) + 1)),
    turn: 1, over: false, youWon: false, redResigned: false, winner: null, seed: null };
  GAMES[g.id] = g;
  return g;
}

// Undo support: every player-visible action (attack / end-turn) pushes the full
// pre-action game state — owner/strength arrays plus the mb32 dice cursor — so undo
// is an exact rewind (replaying the same move re-rolls the same dice).
function snapshot(g) {
  if (!g.hist) g.hist = [];
  g.hist.push({ owner: g.owner.slice(), strength: g.strength.slice(), mb: g.mb,
    turn: g.turn, over: g.over, youWon: g.youWon, redResigned: g.redResigned,
    winner: g.winner });
  if (g.hist.length > 500) g.hist.shift();
}

function doUndo(g) {
  if (!g.hist || !g.hist.length) {
    const out = view(g); out.log = []; out.nothingToUndo = true;
    return out;
  }
  const s = g.hist.pop();
  g.owner = s.owner; g.strength = s.strength; g.mb = s.mb; g.turn = s.turn;
  g.over = s.over; g.youWon = s.youWon; g.redResigned = s.redResigned;
  g.winner = s.winner;
  const out = view(g); out.log = [];
  return out;
}

function doAttack(g, frm, to) {
  snapshot(g);
  select(g);
  E.useMb32(g.mb);
  const { flips, meta } = E.attackLogged(g.owner, g.strength, frm, to);
  g.mb = E.getMb32();
  updateWinner(g);
  const log = [{ type: 'attack', attacker: 'red', from: frm, to,
    captured: meta.captured, fromStart: meta.fromStart, toStart: meta.toStart, flips,
    fromStrength: meta.fromStrength, toStrength: meta.toStrength }];
  const out = view(g); out.log = log;
  return out;
}

// RED reinforce + the four bot turns, replayed move-by-move so the browser can
// animate each step. Drives the SAME C primitives in the SAME order as the engine's
// atomic end_turn (reinforce is RNG-free; only battles advance the mb32 dice), so the
// final board + g.mb are bit-identical to end_turn — just observable. Port of
// server.do_end_turn.
function doEndTurn(g) {
  snapshot(g);
  select(g);
  E.useMb32(g.mb);
  const owner = g.owner, strength = g.strength;
  const events = [];

  const reinforceStep = (fidx) => {
    const before = strength.slice();
    E.reinforce(owner, strength, fidx);
    const ch = [];
    for (let i = 0; i < strength.length; i++)
      if (strength[i] !== before[i]) ch.push({ id: i, to: strength[i] });
    if (ch.length) events.push({ type: 'reinforce', faction: FACTIONS[fidx], changes: ch });
  };

  reinforceStep(0);                                    // RED reinforce
  if (E.checkWinner(owner) < 0) {
    for (let b = 1; b < 5; b++) {                       // green, yellow, blue, purple
      if (E.counts(owner)[b] === 0) continue;           // eliminated faction takes no turn
      let won = false;
      for (let it = 0; it < 1000; it++) {               // bot greedily attacks until none
        const mv = E.bestBotMove(owner, strength, b);
        if (mv === null) break;
        const [frm, to] = mv;
        const attacker = FACTIONS[owner[frm]];
        const fs = strength[frm], ts = strength[to];
        const { flips, meta } = E.attackLogged(owner, strength, frm, to);
        events.push({ type: 'attack', attacker, from: frm, to, fromStart: fs, toStart: ts,
          flips, captured: meta.captured, fromStrength: meta.fromStrength,
          toStrength: meta.toStrength });
        if (E.checkWinner(owner) >= 0) { won = true; break; }
      }
      if (won) break;
      reinforceStep(b);                                 // bot reinforces
    }
  }

  g.mb = E.getMb32();
  g.turn += 1;
  updateWinner(g);
  const out = view(g);
  out.events = events;
  return out;
}

// The SAME C-UCT MCTS the sim/phone driver uses, for RED's current turn. Rolls out on
// the private sim stream (never g.mb, the real game dice), so calling this can't leak
// future dice into play. Port of server.do_search.
// Shape a root-children readout (acts/visits/q from the engine) into the ranked
// {winexp, visits, top, best} the UI speaks — used for both progress + final.
function buildResult(acts, visits, q) {
  if (acts.length === 0) return { winexp: null, visits: 0, top: [], best: null };
  const order = [...acts.keys()].sort((a, b) => visits[b] - visits[a]);
  let tv = 0; for (const v of visits) tv += v;
  const top = [];
  for (const k of order) {
    const a = acts[k];
    const [frm, to] = a === -1 ? [null, null] : [a >> 8, a & 0xFF];
    top.push({ action: a, from: frm, to, visits: visits[k],
      frac: tv ? visits[k] / tv : 0, q: q[k] });
  }
  // `all` is the full ranked list (not just top-8): the blunder alert needs the Q
  // of whatever move the player actually chose, which is often a low-visit tail move.
  return { winexp: top[0].q, visits: tv, top: top.slice(0, 8), all: top, best: top[0] };
}

// Adaptive budget: floor `sims`, ceiling `maxSims`. The search runs past the
// floor only while the top two root moves stay close (it thinks harder exactly
// when the position is close), and stops once the best move is uncatchable.
// maxSims ~150k ≈ up to ~4-5s in the worker on a genuinely contested position.
//
// Driven in CHUNK-sized steps over a persistent tree (bit-identical to the
// one-shot uctSearch) so we can post intermediate root stats: with `tag` set, a
// {type:'progress', tag, result} message is sent after every chunk, letting the
// page watch the suggestions + win% converge live. The final result is returned
// normally; it's the threshold-gated answer autoplay commits its move on.
//
// The loop yields to the event loop between chunks and ABORTS (returning the
// tree's current best) the moment another request lands in `inbox` — an undo,
// attack or end-turn must never wait out a multi-second search. Autoplay is
// unaffected: it awaits each search with nothing else queued, so its searches
// always run to their converged stop.
const SEARCH_CHUNK = 2000;
async function doSearch(g, sims = 2000, cPuct = 2.5, nroll = 1, simSeed = 0x12345678,
                        maxSims = 150000, tag = null) {
  select(g);
  E.useSim(simSeed);
  E.uctBegin(g.owner, g.strength, g.turn, sims, cPuct, nroll, maxSims);
  let done = false;
  while (!done) {
    done = E.uctStep(SEARCH_CHUNK);
    if (tag != null) {
      const r = E.uctReport();
      const out = buildResult(r.acts, r.visits, r.q);
      out.sims = E.uctSimsDone(); out.done = done;
      self.postMessage({ type: 'progress', tag, result: out });
    }
    if (!done) {
      await yieldToInbox();                 // let queued client messages land
      if (inbox.length) break;              // someone is waiting — answer with what we have
    }
  }
  const r = E.uctReport();
  const out = buildResult(r.acts, r.visits, r.q);
  out.sims = E.uctSimsDone(); out.done = done;
  return out;
}

function doSurrender(g) {
  g.over = true; g.redResigned = true; g.youWon = false;
  const out = view(g); out.log = [];
  return out;
}

// ---- message dispatch: mirrors server.py's HTTP routes ----
function route(path, method, body) {
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  body = body || {};

  if (path === '/api/game' && method === 'POST') return view(newGame(body.seed));

  if (path.startsWith('/api/game/')) {
    const rest = path.slice('/api/game/'.length);
    const slash = rest.indexOf('/');
    const gid = slash < 0 ? rest : rest.slice(0, slash);
    const action = slash < 0 ? '' : rest.slice(slash + 1);
    const g = GAMES[gid];
    if (!g) return { error: 'no such game', _status: 404 };
    if (method === 'GET' && action === '') return view(g);
    if (action === 'attack') return doAttack(g, body.from | 0, body.to | 0);
    if (action === 'end-turn') return doEndTurn(g);
    if (action === 'search') return doSearch(g,
      body.sims != null ? body.sims | 0 : 2000, 2.5, 1, 0x12345678,
      body.maxSims != null ? body.maxSims | 0 : 150000,
      body.tag != null ? body.tag : null);
    if (action === 'surrender') return doSurrender(g);
    if (action === 'undo') return doUndo(g);
  }

  // Loading a saved board from the iOS workflow: index.html fetches the file text
  // (server-only) and hands us its nodes here so the WASM engine builds the game.
  if (path === '/load-board' && method === 'POST') return view(gameFromBoard(body.nodes, body.mb));

  return { error: 'not found', _status: 404 };
}

// ---- message pump: requests queue in `inbox` and are served strictly in order.
// The point of the explicit queue (vs handling each message inline) is that the
// search can SEE waiting requests and abort between chunks, so game actions get
// sub-chunk (~50ms) latency instead of queueing behind a multi-second search.
const inbox = [];
let pumping = false;

// Fast macrotask yield via MessageChannel (no setTimeout clamping). Client
// postMessages that arrived during the last uctStep chunk are queued ahead of
// our port message, so they hit `inbox` before the yield resolves.
let _yieldDone = null;
const _yield = new MessageChannel();
_yield.port1.onmessage = () => { const r = _yieldDone; _yieldDone = null; if (r) r(); };
const yieldToInbox = () => new Promise(r => { _yieldDone = r; _yield.port2.postMessage(0); });

self.onmessage = (ev) => { inbox.push(ev.data); pump(); };

async function pump() {
  if (pumping) return;
  pumping = true;
  while (inbox.length) {
    const { id, path, method, body } = inbox.shift();
    try {
      if (!E) {
        E = await loadEngine();
        // Settle on a clear winner: stop once the leading move's win-prob is decisive
        // (<=3% / >=97%) or dominates the rest by >=15pts, with >=512 visits. Offline
        // A/B (adaptive 2k-20k, 80 games): identical 97.5% winrate, ~3x fewer sims/move.
        E.setValueStop(0.03, 0.97, 0.15, 512);
      }
      const result = await route(path, method || 'GET', body);
      self.postMessage({ id, result });
    } catch (err) {
      self.postMessage({ id, result: { error: String(err && err.message || err) } });
    }
  }
  pumping = false;
}
