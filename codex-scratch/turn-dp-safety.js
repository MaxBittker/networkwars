'use strict';

// Strict scratch experiment: short Bellman-style planning within RED's current
// turn. It uses exact public battle outcome probabilities over only the top
// ranked moves, compares each attack against stopping, and never calls api.rng(),
// recovers seeds, mutates live nodes, or stores benchmark-order state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';
const WIN_NODES = 24;

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

function applyOutcome(state, move, outcome) {
  const next = cloneState(state);
  const from = next.nodes[move.from];
  const to = next.nodes[move.to];
  from.strength = outcome.fromStrength;
  if (outcome.captured) to.owner = from.owner;
  to.strength = outcome.toStrength;
  return next;
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

function redRisk(state) {
  let risk = 0;
  let threatened = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      risk += p;
      if (p > 0.45) threatened++;
    }
  }
  return { risk, threatened };
}

function stopValue(state, {
  threatWeight = 95,
  threatenedWeight = 25,
  splitWeight = 25,
  enemyWeight = 18,
} = {}) {
  const s = cloneState(state);
  reinforce(s, HUMAN);
  const c = counts(s);
  if (c.red >= WIN_NODES) return 1000000 + c.red * 10000;
  if (c.red === 0) return -1000000;

  const redComps = components(s, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redStrength = s.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const largestSet = new Set(redComps.find(comp => comp.length === largest) || []);
  const largestStrength = s.nodes
    .filter(n => n.owner === HUMAN && largestSet.has(n.id))
    .reduce((sum, n) => sum + n.strength, 0);
  const borderStrength = s.nodes
    .filter(n => n.owner === HUMAN && s.adj[n.id].some(nb => s.nodes[nb].owner !== HUMAN))
    .reduce((sum, n) => sum + n.strength, 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const risk = redRisk(s);

  return c.red * 155
    + largest * 112
    + redStrength * 5
    + largestStrength * 4
    + borderStrength * 3
    - Math.max(0, redComps.length - 1) * splitWeight
    - risk.risk * threatWeight
    - risk.threatened * threatenedWeight
    - maxEnemy * enemyWeight;
}

function stateKey(state, depth) {
  let key = `${depth}|`;
  for (const n of state.nodes) key += `${n.owner[0]}${n.strength},`;
  return key;
}

function valueState(state, depth, options, cache) {
  const key = stateKey(state, depth);
  if (cache.has(key)) return cache.get(key);

  const stop = stopValue(state, options);
  if (depth <= 0 || counts(state).red >= WIN_NODES) {
    cache.set(key, stop);
    return stop;
  }

  let best = stop;
  const ranked = codex
    .rankedMoveScores(state, { ...codex.FAST_DEFAULTS, ...codex.DELAYED_MERGE_RANKED_OPTIONS })
    .slice(0, options.topK);

  for (const item of ranked) {
    const from = state.nodes[item.move.from];
    const to = state.nodes[item.move.to];
    let expected = 0;
    for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
      expected += outcome.prob * valueState(applyOutcome(state, item.move, outcome), depth - 1, options, cache);
    }
    const score = expected + item.score * options.rankWeight;
    if (score > best) best = score;
  }

  cache.set(key, best);
  return best;
}

function selectTurnDpMove(state, {
  topK = 2,
  depth = 2,
  margin = 14,
  rankWeight = 0.05,
  ...valueOptions
} = {}) {
  const options = { topK, depth, margin, rankWeight, ...valueOptions };
  const cache = new Map();
  const stop = valueState(state, 0, options, cache);
  let best = null;
  let bestValue = -Infinity;

  const ranked = codex
    .rankedMoveScores(state, { ...codex.FAST_DEFAULTS, ...codex.DELAYED_MERGE_RANKED_OPTIONS })
    .slice(0, topK);

  for (const item of ranked) {
    const from = state.nodes[item.move.from];
    const to = state.nodes[item.move.to];
    let expected = 0;
    for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
      expected += outcome.prob * valueState(applyOutcome(state, item.move, outcome), depth - 1, options, cache);
    }
    const value = expected + item.score * rankWeight;
    if (value > bestValue) {
      best = item.move;
      bestValue = value;
    }
  }

  return best && bestValue > stop + margin ? best : null;
}

function makeTurnDpSafety({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  ...moveOptions
} = {}) {
  let openingHandled = false;

  return function turnDpSafety(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = codex.selectOpeningDefenseMove(state, {
          rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
          minP: 0.55,
          minScore: 60,
          riskWeight: 55,
        });
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = selectTurnDpMove(state, moveOptions);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

const candidateFactories = {
  safetyK2: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }),
  threat36: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, threatenedWeight: 36 }),
  dp2m0: () => makeTurnDpSafety({ depth: 2, topK: 2, margin: 0 }),
  dp2m12: () => makeTurnDpSafety({ depth: 2, topK: 2, margin: 12 }),
  dp2safe: () => makeTurnDpSafety({ depth: 2, topK: 2, margin: 20, threatWeight: 120 }),
  dp3k1: () => makeTurnDpSafety({ depth: 3, topK: 1, margin: 8 }),
  dpThreat: () => makeTurnDpSafety({ depth: 2, topK: 2, margin: 8, threatenedWeight: 45 }),
};

function main() {
  const games = Number(process.argv[2]) || 80;
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
    console.log(`${row.name.padEnd(10)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeTurnDpSafety,
  selectTurnDpMove,
};
