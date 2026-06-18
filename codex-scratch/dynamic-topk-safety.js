'use strict';

// Strict scratch experiment: gap-triggered SafetyK2 with a simple visible-state
// rule that chooses how many ranked candidate moves get exact safety scoring.
// No api.rng(), seed recovery, live-node mutation, board fingerprints, or
// benchmark-order state.

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

function stateFeatures(state) {
  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redNodes = state.nodes.filter(n => n.owner === HUMAN);
  const redStrength = redNodes.reduce((sum, n) => sum + n.strength, 0);
  let risk = 0;
  let threatened = 0;
  let beatable = 0;
  let weakBorder = 0;

  for (const n of redNodes) {
    if (n.strength <= 2 && state.adj[n.id].some(nb => state.nodes[nb].owner !== HUMAN)) {
      weakBorder++;
    }
  }

  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const nbId of state.adj[n.id]) {
      const target = state.nodes[nbId];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      risk += p;
      beatable++;
      if (p > 0.45) threatened++;
    }
  }

  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  return {
    red: c.red,
    maxEnemy,
    gap: maxEnemy - c.red,
    largest,
    splits: Math.max(0, redComps.length - 1),
    legal: legalMoves(state).length,
    risk10: Math.round(risk * 10),
    threatened,
    beatable,
    weakBorder,
    redStrength,
    strengthPerNode10: c.red ? Math.round((redStrength / c.red) * 10) : 0,
  };
}

function matchesRule(features, rule) {
  if (!rule) return false;
  const value = features[rule.feature];
  return rule.op === '<=' ? value <= rule.cut : value >= rule.cut;
}

function makeDynamicTopKSafety({
  rule = null,
  highWhenMatch = true,
  lowTopK = 2,
  highTopK = 5,
  gapCut = 2,
  lowThreatenedWeight = 16,
  highThreatenedWeight = 36,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
} = {}) {
  let openingHandled = false;

  return function dynamicTopKSafety(api) {
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
      const c = counts(state);
      if (c.red >= WIN_NODES) return;

      const features = stateFeatures(state);
      const matched = matchesRule(features, rule);
      const useHighTopK = matched ? highWhenMatch : !highWhenMatch;
      const maxEnemy = Math.max(...BOTS.map(f => c[f]));
      const threatenedWeight = maxEnemy - c.red >= gapCut ? highThreatenedWeight : lowThreatenedWeight;

      const move = codex.selectSafetyRankedMove(state, {
        rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
        minScore: 210,
        splitWeight: 25,
        threatenedWeight,
        topK: useHighTopK ? highTopK : lowTopK,
      });
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function candidateRules({ targeted = false } = {}) {
  const out = [
    ['gap2', () => codex.codexSafetyGap2ThreatFast],
    ['gap5', () => codex.codexSafetyGap2Threat],
  ];
  const axes = targeted
    ? {
        red: [3, 4, 5, 6, 8],
        gap: [2, 4, 6, 8],
        largest: [3, 4, 5, 6, 8],
        legal: [6, 10, 15, 20],
        risk10: [0, 6, 15, 25, 40],
      }
    : {
        red: [3, 4, 5, 6, 8, 10, 12, 14, 18],
        gap: [-2, 0, 2, 4, 6, 8],
        largest: [2, 3, 4, 5, 6, 8, 10, 12],
        splits: [0, 1, 2, 3, 4],
        legal: [2, 4, 6, 10, 15, 20, 30],
        risk10: [0, 3, 6, 10, 15, 25, 40],
        threatened: [0, 1, 2, 3, 4],
        beatable: [0, 1, 2, 3, 5, 8],
        weakBorder: [0, 1, 2, 3, 4],
        strengthPerNode10: [15, 20, 25, 30, 35, 40, 50],
      };

  for (const [feature, cuts] of Object.entries(axes)) {
    for (const cut of cuts) {
      for (const op of ['<=', '>=']) {
        for (const highWhenMatch of [true, false]) {
          const rule = { feature, op, cut };
          const dir = highWhenMatch ? 'hi' : 'lo';
          out.push([
            `${feature}${op}${cut}->${dir}`,
            () => makeDynamicTopKSafety({ rule, highWhenMatch }),
          ]);
        }
      }
    }
  }
  return out;
}

function scoreCandidate(name, factory, games, bases) {
  let total = 0;
  let totalMs = 0;
  const parts = [];
  for (const seedBase of bases) {
    const result = sim.scorePolicy(factory(), { games, seedBase });
    total += result.wins;
    totalMs += result.totalMs;
    parts.push(`${seedBase}:${result.wins}/${games}`);
  }
  return { name, total, parts, msPerGame: totalMs / (games * bases.length) };
}

function main() {
  const games = Number(process.argv[2]) || 80;
  const targeted = process.argv.includes('--targeted');
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 2001, 10001, 50001);

  const rows = [];
  for (const [name, factory] of candidateRules({ targeted })) {
    rows.push(scoreCandidate(name, factory, games, bases));
  }
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows.slice(0, 40)) {
    console.log(`${row.name.padEnd(28)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeDynamicTopKSafety,
  stateFeatures,
};
