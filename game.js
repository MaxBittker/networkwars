'use strict';

// ---------------------------------------------------------------------------
// Network Wars — pure rules engine (no I/O). See DESIGN.md for the rules.
// ---------------------------------------------------------------------------

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';

const GRID_ROWS = 7;       // real iOS app uses a 6-wide x 7-tall grid (measured via mirror)
const GRID_COLS = 6;       // 42 grid cells...
const TARGET_NODES = 30;   // ...minus 12 random vertices = 30 nodes, 6 per faction
const WIN_NODES = 24;
const ATTACKER_WIN_P = 0.55;

// --- seeded RNG (mulberry32) -----------------------------------------------
function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Cluster each faction into ~2-3 connected territories (matches the real app, which
// does not scatter ownership uniformly). Seeded territorial growth with scatter.
const OWNER_SEEDS = 1;       // initial seeds per faction
const OWNER_SCATTER = 0.6;   // P(a growth step jumps to a random free node => new cluster)
function assignOwnership(nodes, adj, rng) {
  const N = nodes.length;
  const ids = Array.from({ length: N }, (_, i) => i);
  const owner = new Array(N).fill(null);
  const counts = {}; for (const f of FACTIONS) counts[f] = 0;
  const pool = shuffle([...ids], rng);
  let p = 0;
  for (let s = 0; s < OWNER_SEEDS; s++) for (const f of FACTIONS) { owner[pool[p++]] = f; counts[f]++; }
  let guard = 0;
  while (FACTIONS.some(f => counts[f] < 6) && guard++ < 10000) {
    for (const f of shuffle([...FACTIONS], rng)) {
      if (counts[f] >= 6) continue;
      const free = ids.filter(i => owner[i] === null);
      let pick;
      if (rng() < OWNER_SCATTER) {
        pick = free[Math.floor(rng() * free.length)];
      } else {
        const border = [];
        for (let i = 0; i < N; i++) {
          if (owner[i] !== f) continue;
          for (const nb of adj[i]) if (owner[nb] === null && !border.includes(nb)) border.push(nb);
        }
        pick = border.length ? border[Math.floor(rng() * border.length)]
                             : free[Math.floor(rng() * free.length)];
      }
      owner[pick] = f; counts[f]++;
    }
  }
  nodes.forEach((n, i) => { n.owner = owner[i]; });
}

// --- board generation -------------------------------------------------------
// Diamond/triangular lattice: each cell links down, down-left, down-right.
// Vertical links bridge the two checkerboard parities so the graph is connected.
// Irregularity comes from removing random *vertices* (never edges), keeping the
// graph connected, until TARGET_NODES remain.
function buildBoard(rng) {
  const gidAt = (r, c) => r * GRID_COLS + c;
  const cellCount = GRID_ROWS * GRID_COLS;

  // grid adjacency over the full lattice (by grid id)
  const gridAdj = Array.from({ length: cellCount }, () => new Set());
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const a = gidAt(r, c);
      const link = (b) => { gridAdj[a].add(b); gridAdj[b].add(a); };
      if (c + 1 < GRID_COLS) link(gidAt(r, c + 1));    // right (horizontal)
      if (r + 1 < GRID_ROWS) {
        link(gidAt(r + 1, c));                         // down
        if (c - 1 >= 0) link(gidAt(r + 1, c - 1));     // down-left
        if (c + 1 < GRID_COLS) link(gidAt(r + 1, c + 1)); // down-right
      }
    }
  }

  // Remove random vertices, but only ones whose removal keeps the rest connected.
  const alive = new Set(Array.from({ length: cellCount }, (_, i) => i));
  const stillConnected = (excluded) => {
    const start = [...alive].find(g => g !== excluded);
    if (start === undefined) return false;
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const g = stack.pop();
      for (const nb of gridAdj[g]) {
        if (nb !== excluded && alive.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    return seen.size === alive.size - 1;
  };
  while (alive.size > TARGET_NODES) {
    const candidates = shuffle([...alive], rng);
    let removed = false;
    for (const gid of candidates) {
      if (stillConnected(gid)) { alive.delete(gid); removed = true; break; }
    }
    if (!removed) break; // no safe removal left (won't happen at these sizes)
  }

  // Reindex survivors to contiguous node ids 0..N-1; carry grid coords for layout.
  const survivors = [...alive].sort((a, b) => a - b);
  const newId = new Map(survivors.map((g, i) => [g, i]));
  const nodes = survivors.map((g, i) => ({
    id: i, x: g % GRID_COLS, y: Math.floor(g / GRID_COLS), owner: null, strength: 1,
  }));

  const linkSet = new Set();
  const links = [];
  for (const g of survivors) {
    for (const nb of gridAdj[g]) {
      if (!alive.has(nb)) continue;
      const a = newId.get(g), b = newId.get(nb);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (linkSet.has(key)) continue;
      linkSet.add(key);
      links.push([Math.min(a, b), Math.max(a, b)]);
    }
  }

  // adjacency
  const adj = nodes.map(() => []);
  for (const [a, b] of links) { adj[a].push(b); adj[b].push(a); }

  // ownership: the real app clusters each faction into ~2-3 connected territories,
  // NOT a uniform scatter. Measured components-per-faction: real mean 3.07 (73% <=3
  // clusters) vs 3.92 (34%) for a uniform shuffle. We reproduce it with seeded
  // territorial growth: one seed per faction, then round-robin BFS growth where each
  // step grows a border node, except with prob OWNER_SCATTER it jumps to a random free
  // node (starting a new cluster). Tuned to the real distribution (n=3 openings).
  assignOwnership(nodes, adj, rng);

  // initial strengths: measured from the real app — a bimodal distribution, not 1..5.
  // ~half the nodes start at 1; the rest cluster in 4..8 (mean ~6). Observed sample
  // (2 openings, 60 nodes): {1:31, 4:2, 5:9, 6:12, 8:6}. Model: 50% -> 1, else 4..8.
  // Then guarantee every faction can move on turn 1.
  for (const n of nodes) n.strength = rng() < 0.5 ? 1 : 4 + Math.floor(rng() * 5);
  for (const f of FACTIONS) {
    const owned = nodes.filter(n => n.owner === f);
    if (owned.every(n => n.strength <= 1)) {
      owned[Math.floor(rng() * owned.length)].strength = 2;
    }
  }

  return { nodes, links, adj };
}

// --- core mechanics ---------------------------------------------------------
function counts(state) {
  const c = {};
  for (const f of FACTIONS) c[f] = 0;
  for (const n of state.nodes) c[n.owner]++;
  return c;
}

function checkWinner(state) {
  const c = counts(state);
  for (const f of FACTIONS) if (c[f] >= WIN_NODES) return f;
  const alive = FACTIONS.filter(f => c[f] > 0);
  if (alive.length === 1) return alive[0];
  return null;
}

// Resolve a full battle from node `from` into node `to`. Mutates state.
// Returns a log entry. Caller must ensure the move is legal.
function resolveBattle(state, fromId, toId) {
  const from = state.nodes[fromId];
  const to = state.nodes[toId];
  const attacker = from.owner, defender = to.owner;
  const fromStart = from.strength, toStart = to.strength;
  let a = from.strength;
  let d = to.strength;
  const flips = [];            // 'd' = defender lost a unit, 'a' = attacker lost a unit
  while (a > 1 && d > 0) {
    if (state.rng() < ATTACKER_WIN_P) {
      d--; flips.push('d');
      // the attacker's last striker (a===2) is spent clearing the final defender:
      // it captures the node but has nothing left to spread in -> the node ends at 0.
      if (d === 0 && a === 2) a--;
    }
    else { a--; flips.push('a'); }
  }
  let captured = false;
  if (d === 0) {
    captured = true;
    to.owner = from.owner;
    to.strength = a - 1;     // 0 when the attacker was reduced to its garrison
    from.strength = 1;
  } else {
    from.strength = a;
    to.strength = d;
  }
  return {
    type: 'attack', attacker, defender,
    from: fromId, to: toId, captured,
    fromStart, toStart, flips,
    fromStrength: from.strength, toStrength: to.strength,
  };
}

function componentsOf(state, faction) {
  const seen = new Set();
  const comps = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || seen.has(n.id)) continue;
    const comp = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const nb of state.adj[id]) {
        if (!seen.has(nb) && state.nodes[nb].owner === faction) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function reinforce(state, faction) {
  const comps = componentsOf(state, faction);
  if (!comps.length) return null;
  let largest = comps[0];
  for (const comp of comps) if (comp.length > largest.length) largest = comp;
  const N = largest.length;
  const border = largest
    .filter(id => state.adj[id].some(nb => state.nodes[nb].owner !== faction))
    .sort((x, y) => x - y);
  if (!border.length) return null;
  for (let i = 0; i < N; i++) state.nodes[border[i % border.length]].strength++;
  return { type: 'reinforce', faction, amount: N, border };
}

// All legal RED attacks: from an owned node (strength>1) into any enemy neighbor.
function legalMoves(state, faction) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || n.strength <= 1) continue;
    for (const nb of state.adj[n.id]) {
      if (state.nodes[nb].owner !== faction) moves.push({ from: n.id, to: nb });
    }
  }
  return moves;
}

// Bot move: attack the weakest beatable neighbor (strictly stronger required).
// Tie-break: lowest target strength, then highest attacker strength, then ids.
function bestBotMove(state, faction) {
  let best = null;
  for (const n of state.nodes) {
    if (n.owner !== faction || n.strength <= 1) continue;
    for (const nb of state.adj[n.id]) {
      const t = state.nodes[nb];
      if (t.owner === faction || t.strength >= n.strength) continue;
      const cand = { from: n.id, to: nb, atk: n.strength, def: t.strength };
      if (!best
        || cand.def < best.def
        || (cand.def === best.def && cand.atk > best.atk)
        || (cand.def === best.def && cand.atk === best.atk && cand.from < best.from)
        || (cand.def === best.def && cand.atk === best.atk && cand.from === best.from && cand.to < best.to)) {
        best = cand;
      }
    }
  }
  return best;
}

function runBotTurn(state, faction, log) {
  if (counts(state)[faction] === 0) return;
  let guard = 0;
  while (guard++ < 1000) {
    const move = bestBotMove(state, faction);
    if (!move) break;
    log.push(resolveBattle(state, move.from, move.to));
    if (checkWinner(state)) return; // game decided mid-turn
  }
  const r = reinforce(state, faction);
  if (r) log.push(r);
}

module.exports = {
  FACTIONS, BOTS, HUMAN, WIN_NODES, GRID_ROWS, GRID_COLS, TARGET_NODES,
  makeRng, buildBoard, counts, checkWinner, resolveBattle,
  componentsOf, reinforce, legalMoves, bestBotMove, runBotTurn,
};
