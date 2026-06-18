'use strict';

// Strict scratch experiment: SafetyK2 with a simple visible-state rule that
// switches the threatened-red-node weight between the robust default and the
// canonical-strong Threat36 setting. No api.rng(), seed recovery, live-node
// mutation, board fingerprints, or benchmark-order state.

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
  let risk = 0;
  let threatened = 0;
  let redStrength = 0;
  let borderWeak = 0;

  for (const n of state.nodes) {
    if (n.owner === HUMAN) {
      redStrength += n.strength;
      if (n.strength <= 2 && state.adj[n.id].some(nb => state.nodes[nb].owner !== HUMAN)) {
        borderWeak++;
      }
      continue;
    }
    if (n.strength <= 1) continue;
    for (const nbId of state.adj[n.id]) {
      const target = state.nodes[nbId];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      risk += p;
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
    risk,
    risk10: Math.round(risk * 10),
    threatened,
    redStrength,
    borderWeak,
  };
}

function matchesRule(features, rule) {
  if (!rule) return false;
  const value = features[rule.feature];
  return rule.op === '<=' ? value <= rule.cut : value >= rule.cut;
}

function makeDynamicThreatSafety({
  rule = null,
  highWhenMatch = true,
  highThreatenedWeight = 36,
  lowThreatenedWeight = 16,
  highMinScore = 210,
  lowMinScore = 210,
  highSplitWeight = 25,
  lowSplitWeight = 25,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
} = {}) {
  let openingHandled = false;

  return function dynamicThreatSafety(api) {
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
      const features = stateFeatures(state);
      const matched = matchesRule(features, rule);
      const useHigh = matched ? highWhenMatch : !highWhenMatch;
      const move = codex.selectSafetyRankedMove(state, {
        rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
        minScore: useHigh ? highMinScore : lowMinScore,
        splitWeight: useHigh ? highSplitWeight : lowSplitWeight,
        threatenedWeight: useHigh ? highThreatenedWeight : lowThreatenedWeight,
      });
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function candidateRules() {
  const rules = [
    ['k2', () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 })],
    ['threat36', () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, threatenedWeight: 36 })],
  ];
  const axes = {
    red: [3, 4, 5, 6, 8, 10, 12, 14],
    gap: [-2, 0, 2, 4, 6, 8],
    largest: [3, 4, 5, 6, 8, 10, 12],
    splits: [1, 2, 3, 4],
    legal: [3, 6, 10, 15, 20, 30],
    risk10: [0, 5, 10, 15, 20, 30],
    threatened: [0, 1, 2, 3, 4],
    borderWeak: [0, 1, 2, 3, 4],
  };

  for (const [feature, cuts] of Object.entries(axes)) {
    for (const cut of cuts) {
      for (const op of ['<=', '>=']) {
        const rule = { feature, op, cut };
        rules.push([`${feature}${op}${cut}->hi`, () => makeDynamicThreatSafety({ rule, highWhenMatch: true })]);
        rules.push([`${feature}${op}${cut}->lo`, () => makeDynamicThreatSafety({ rule, highWhenMatch: false })]);
      }
    }
  }
  return rules;
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
  const games = Number(process.argv[2]) || 50;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 10001);

  const rows = [];
  for (const [name, factory] of candidateRules()) {
    rows.push(scoreCandidate(name, factory, games, bases));
  }

  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.name.padEnd(22)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeDynamicThreatSafety,
  stateFeatures,
};
