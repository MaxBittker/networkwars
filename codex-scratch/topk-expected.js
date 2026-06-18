'use strict';

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];

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

function legalMoves(state) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== 'red' || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      if (state.nodes[to].owner !== 'red') moves.push({ from: n.id, to });
    }
  }
  return moves;
}

function openingOkCount(state) {
  let ok = 0;
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    if (codex.captureProbability(from.strength, to.strength) > 0.4) ok++;
  }
  return ok;
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

function valueAfterReinforce(state, weights) {
  const next = cloneState(state);
  reinforce(next, 'red');
  return codex.evaluatePosition(next, weights);
}

function lightValueAfterReinforce(state) {
  const next = cloneState(state);
  reinforce(next, 'red');
  const c = counts(next);
  if (c.red >= 24) return 100000;
  if (c.red === 0) return -100000;

  const redComps = components(next, 'red');
  const largestRed = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const redStrength = next.nodes
    .filter(n => n.owner === 'red')
    .reduce((sum, n) => sum + n.strength, 0);
  const borderStrength = next.nodes
    .filter(n => n.owner === 'red' && next.adj[n.id].some(nb => next.nodes[nb].owner !== 'red'))
    .reduce((sum, n) => sum + n.strength, 0);

  return c.red * 170
    - maxEnemy * 75
    + largestRed * 115
    + redStrength * 4
    + borderStrength * 3
    - Math.max(0, redComps.length - 1) * 55;
}

function makeTopKExpected({
  threshold = 13,
  highOpportunity = codex.C1_RANKED_OPTIONS,
  fallback = codex.C4_RANKED_OPTIONS,
  topK = 4,
  gainThreshold = 8,
  pressureFloor = -20,
  leaderBonus = 13,
  endDrop = 14,
  maxAttacks = 90,
  weights = codex.DEFAULT_WEIGHTS,
  lightValue = false,
} = {}) {
  const highOptions = { ...codex.FAST_DEFAULTS, ...highOpportunity };
  const fallbackOptions = { ...codex.FAST_DEFAULTS, ...fallback };
  let mode = null;

  return function topKExpected(api) {
    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (mode === null || isOpening(state)) {
        mode = openingOkCount(state) >= threshold ? 'high' : 'fallback';
      }

      const c = counts(state);
      if (c.red >= 24) return;
      const options = mode === 'high' ? highOptions : fallbackOptions;
      const enemyCounts = BOTS.map(f => c[f]).sort((a, b) => b - a);
      const maxEnemy = enemyCounts[0];
      const secondEnemy = enemyCounts[1];
      const pressureThreshold = options.threshold - Math.max(0, c.red - 14) * endDrop;
      const valueFn = lightValue ? lightValueAfterReinforce : s => valueAfterReinforce(s, weights);
      const base = valueFn(state);

      let best = null;
      let bestExpectedGain = -Infinity;
      let bestPressureMargin = -Infinity;

      for (const item of codex.rankedMoveScores(state, options).slice(0, topK)) {
        const move = item.move;
        const to = state.nodes[move.to];
        let pressureScore = item.score;
        if (c[to.owner] === maxEnemy) {
          const leaderGap = Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1);
          pressureScore += leaderBonus * leaderGap;
        }

        let expected = 0;
        const from = state.nodes[move.from];
        for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
          expected += outcome.prob * valueFn(applyOutcome(state, move, outcome));
        }

        const gain = expected - base;
        const pressureMargin = pressureScore - pressureThreshold;
        if (gain > bestExpectedGain || (gain === bestExpectedGain && pressureMargin > bestPressureMargin)) {
          best = move;
          bestExpectedGain = gain;
          bestPressureMargin = pressureMargin;
        }
      }

      if (!best || bestExpectedGain < gainThreshold || bestPressureMargin < pressureFloor) return;
      api.attack(best.from, best.to);
    }
  };
}

function main() {
  const games = Number(process.argv[2]) || 100;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const candidates = {
    pressure: () => codex.makePressureStrategy(),
    top4g0: () => makeTopKExpected({ topK: 4, gainThreshold: 0 }),
    top4g8: () => makeTopKExpected({ topK: 4, gainThreshold: 8 }),
    top3g16: () => makeTopKExpected({ topK: 3, gainThreshold: 16 }),
    top2g8: () => makeTopKExpected({ topK: 2, gainThreshold: 8 }),
    light2g0: () => makeTopKExpected({ topK: 2, gainThreshold: 0, lightValue: true }),
    light4g0: () => makeTopKExpected({ topK: 4, gainThreshold: 0, lightValue: true }),
  };

  const rows = [];
  for (const [name, factory] of Object.entries(candidates)) {
    let total = 0;
    const parts = [];
    let ms = 0;
    for (const seedBase of seedBases) {
      const r = sim.scorePolicy(factory(), { games, seedBase });
      total += r.wins;
      ms += r.totalMs;
      parts.push(`${seedBase}:${r.wins}/${games}`);
    }
    rows.push({ name, total, parts, msPerGame: ms / (games * seedBases.length) });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    console.log(`${row.name.padEnd(10)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeTopKExpected };
