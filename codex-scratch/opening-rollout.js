'use strict';

// Strict scratch experiment: improve only the first RED turn. It compares pass
// against a few high-probability opening attacks using deterministic synthetic
// samples from the visible board, then delegates to SafetyK2 for the rest.
// It never calls api.rng(), recovers seeds, mutates live nodes, or uses
// benchmark-order state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';
const WIN_NODES = 24;
const ATTACKER_WIN_P = 0.55;

function cloneFromApi(api) {
  const nodes = api.nodes.map(n => ({
    id: n.id,
    x: n.x,
    y: n.y,
    owner: n.owner,
    strength: n.strength,
  }));
  return { nodes, adj: nodes.map(n => api.neighbors(n.id).slice()) };
}

function cloneState(state) {
  return {
    nodes: state.nodes.map(n => ({
      id: n.id,
      x: n.x,
      y: n.y,
      owner: n.owner,
      strength: n.strength,
    })),
    adj: state.adj,
  };
}

function counts(state) {
  const out = Object.fromEntries(FACTIONS.map(f => [f, 0]));
  for (const n of state.nodes) out[n.owner]++;
  return out;
}

function winner(state) {
  const c = counts(state);
  for (const f of FACTIONS) if (c[f] >= WIN_NODES) return f;
  const alive = FACTIONS.filter(f => c[f] > 0);
  return alive.length === 1 ? alive[0] : null;
}

function components(state, faction) {
  const seen = new Set();
  const out = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || seen.has(n.id)) continue;
    const comp = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const nb of state.adj[id]) {
        if (state.nodes[nb].owner === faction && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

function reinforce(state, faction) {
  const comps = components(state, faction);
  if (!comps.length) return;
  let largest = comps[0];
  for (const comp of comps) if (comp.length > largest.length) largest = comp;
  const border = largest
    .filter(id => state.adj[id].some(nb => state.nodes[nb].owner !== faction))
    .sort((a, b) => a - b);
  if (!border.length) return;
  for (let i = 0; i < largest.length; i++) {
    state.nodes[border[i % border.length]].strength++;
  }
}

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function legalMoves(state) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      if (state.nodes[to].owner !== HUMAN) moves.push({ from: n.id, to });
    }
  }
  return moves;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stateHash(state, salt = 0) {
  let h = (0x811C9DC5 ^ salt) >>> 0;
  for (const n of state.nodes) {
    const ownerIdx = FACTIONS.indexOf(n.owner) + 1;
    h ^= ((n.id + 1) * 97) ^ (ownerIdx * 193) ^ (n.strength * 8191);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function moveHash(move) {
  if (!move) return 0xABCDEF01;
  return ((move.from + 1) * 65537 + (move.to + 1) * 4099) >>> 0;
}

function resolveBattleSample(state, move, rng) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  let a = from.strength;
  let d = to.strength;
  while (a > 1 && d > 0) {
    if (rng() < ATTACKER_WIN_P) d--;
    else a--;
  }
  from.strength = 1;
  if (d === 0) {
    to.owner = from.owner;
    to.strength = a - 1;
  } else {
    to.strength = d;
  }
}

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

function runBotTurnSample(state, faction, rng) {
  if (counts(state)[faction] === 0) return;
  for (let guard = 0; guard < 1000; guard++) {
    const move = bestBotMove(state, faction);
    if (!move) break;
    resolveBattleSample(state, move, rng);
    if (winner(state)) return;
  }
  reinforce(state, faction);
}

function finishRoundSample(state, rng) {
  reinforce(state, HUMAN);
  if (winner(state)) return;
  for (const bot of BOTS) {
    runBotTurnSample(state, bot, rng);
    if (winner(state)) return;
  }
}

function redRisk(state) {
  let risk = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner === HUMAN && n.strength > target.strength) {
        risk += codex.captureProbability(n.strength, target.strength);
      }
    }
  }
  return risk;
}

function boardValue(state) {
  const w = winner(state);
  if (w) return w === HUMAN ? 100000 : -100000;

  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redStrength = state.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  return c.red * 180
    + largest * 120
    + redStrength * 5
    - maxEnemy * 45
    - Math.max(0, redComps.length - 1) * 36
    - redRisk(state) * 85;
}

function openingMoveCandidates(state, limit, minP) {
  return legalMoves(state)
    .map(move => {
      const from = state.nodes[move.from];
      const to = state.nodes[move.to];
      const p = codex.captureProbability(from.strength, to.strength);
      let score = p * 100
        + (from.strength - to.strength) * 5
        + (to.strength <= 2 ? 12 : 0);
      for (const nbId of state.adj[to.id]) {
        if (state.nodes[nbId].owner === HUMAN) score += 8;
      }
      return { move, p, score };
    })
    .filter(item => item.p >= minP)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.move);
}

function sampledOpeningValue(state, move, samples) {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const s = cloneState(state);
    const rng = makeRng(stateHash(state, (i + 1) * 7919 + moveHash(move)));
    if (move) resolveBattleSample(s, move, rng);
    finishRoundSample(s, rng);
    total += boardValue(s);
  }
  return total / samples;
}

function selectOpeningRolloutMove(state, {
  samples = 6,
  candidateLimit = 6,
  minP = 0.45,
  margin = 18,
} = {}) {
  const stopValue = sampledOpeningValue(state, null, samples);
  let best = null;
  let bestValue = stopValue;

  for (const move of openingMoveCandidates(state, candidateLimit, minP)) {
    const value = sampledOpeningValue(state, move, samples);
    if (value > bestValue) {
      best = move;
      bestValue = value;
    }
  }

  return best && bestValue >= stopValue + margin ? best : null;
}

function makeOpeningRolloutSafety({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  openingOptions = {},
  safetyOptions = {},
} = {}) {
  let openingHandled = false;

  return function openingRolloutSafety(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectOpeningRolloutMove(state, openingOptions);
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = codex.selectSafetyRankedMove(state, {
        rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
        minScore: 210,
        splitWeight: 25,
        ...safetyOptions,
      });
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

const candidateFactories = {
  safetyK2: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }),
  threat36: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, threatenedWeight: 36 }),
  open6: () => makeOpeningRolloutSafety({ openingOptions: { samples: 6, candidateLimit: 6, minP: 0.45, margin: 18 } }),
  open8: () => makeOpeningRolloutSafety({ openingOptions: { samples: 8, candidateLimit: 6, minP: 0.45, margin: 18 } }),
  openStrict: () => makeOpeningRolloutSafety({ openingOptions: { samples: 6, candidateLimit: 5, minP: 0.55, margin: 24 } }),
  openLoose: () => makeOpeningRolloutSafety({ openingOptions: { samples: 6, candidateLimit: 8, minP: 0.35, margin: 10 } }),
  openThreat: () => makeOpeningRolloutSafety({
    openingOptions: { samples: 6, candidateLimit: 6, minP: 0.45, margin: 18 },
    safetyOptions: { threatenedWeight: 36 },
  }),
};

function main() {
  const games = Number(process.argv[2]) || 100;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 10001);

  const rows = [];
  for (const [name, factory] of Object.entries(candidateFactories)) {
    let total = 0;
    let totalMs = 0;
    const parts = [];
    for (const seedBase of bases) {
      const result = sim.scorePolicy(factory(), { games, seedBase });
      total += result.wins;
      totalMs += result.totalMs;
      parts.push(`${seedBase}:${result.wins}/${games}`);
    }
    rows.push({ name, total, parts, msPerGame: totalMs / (games * bases.length) });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    console.log(`${row.name.padEnd(12)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeOpeningRolloutSafety,
  selectOpeningRolloutMove,
};
