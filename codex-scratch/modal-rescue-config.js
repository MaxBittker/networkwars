'use strict';

// Strict scratch experiment: keep the validated modal opening, then switch
// between the current top-six safety midgame and a small rescue config based on
// current public board features. No api.rng(), seed recovery, board lookup
// tables, live-node mutation, or benchmark-order state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';
const WIN_NODES = 24;

const CONFIGS = {
  current: { topK: 6, countWeight: 14 },
  active190: { topK: 6, countWeight: 14, minScore: 190 },
  active200: { topK: 6, countWeight: 14, minScore: 200 },
  red36: { topK: 6, countWeight: 14, redGainWeight: 36 },
  red44: { topK: 6, countWeight: 14, redGainWeight: 44 },
  rescue: { topK: 6, countWeight: 10, minScore: 190, redGainWeight: 44, safetyWeight: 35 },
  rescueSafe: { topK: 6, countWeight: 14, minScore: 200, redGainWeight: 36 },
  wide: { topK: 8, countWeight: 12, minScore: 200, redGainWeight: 36 },
  fast: { topK: 2, countWeight: 4 },
};

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
    if (state.adj[n.id].some(nb => state.nodes[nb].owner !== HUMAN) && n.strength <= 2) weakBorder++;
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

function moveConfigForState(state, config) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const threatenedWeight = maxEnemy - c.red >= 2 ? 36 : 16;
  return {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    topK: 6,
    countWeight: 14,
    minScore: 210,
    splitWeight: 25,
    threatenedWeight,
    ...config,
  };
}

function makeModalRescueConfig({
  rule = null,
  matchConfig = CONFIGS.current,
  missConfig = CONFIGS.current,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
} = {}) {
  let openingHandled = false;

  return function modalRescueConfig(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = codex.selectModalOpeningMove(state);
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const features = stateFeatures(state);
      const config = matchesRule(features, rule) ? matchConfig : missConfig;
      const move = codex.selectSafetyRankedMove(state, moveConfigForState(state, config));
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function candidateRules(pair = 'active200-current', { targeted = false } = {}) {
  const [aName, bName] = pair.split('-');
  const a = CONFIGS[aName];
  const b = CONFIGS[bName];
  if (!a || !b) throw new Error(`unknown pair: ${pair}`);

  const out = [
    [aName, () => makeModalRescueConfig({ rule: { feature: 'red', op: '>=', cut: -1 }, matchConfig: a, missConfig: a })],
    [bName, () => makeModalRescueConfig({ rule: { feature: 'red', op: '>=', cut: -1 }, matchConfig: b, missConfig: b })],
  ];

  const axes = targeted
    ? {
        red: [3, 4, 5, 6],
        gap: [4, 6, 8],
        largest: [3, 4, 5, 6],
        risk10: [0, 10, 25, 40],
      }
    : {
        red: [3, 4, 5, 6, 8, 10, 12],
        gap: [0, 2, 4, 6, 8],
        largest: [2, 3, 4, 5, 6, 8, 10],
        splits: [0, 1, 2, 3],
        legal: [2, 4, 6, 10, 15, 20],
        risk10: [0, 3, 6, 10, 15, 25, 40],
        threatened: [0, 1, 2, 3, 4],
        beatable: [0, 1, 2, 3, 5, 8],
        weakBorder: [0, 1, 2, 3, 4],
        strengthPerNode10: [15, 20, 25, 30, 35, 40, 50],
      };

  for (const [feature, cuts] of Object.entries(axes)) {
    for (const cut of cuts) {
      for (const op of ['<=', '>=']) {
        out.push([
          `${feature}${op}${cut}?${aName}`,
          () => makeModalRescueConfig({ rule: { feature, op, cut }, matchConfig: a, missConfig: b }),
        ]);
        out.push([
          `${feature}${op}${cut}?${bName}`,
          () => makeModalRescueConfig({ rule: { feature, op, cut }, matchConfig: b, missConfig: a }),
        ]);
      }
    }
  }
  return out;
}

function argValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map(Number).filter(Number.isFinite);
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
  return { name, total, totalGames: games * bases.length, parts, msPerGame: totalMs / (games * bases.length) };
}

function main() {
  const games = Number(argValue('games')) || 80;
  const bases = parseList(argValue('bases'), [1, 1001, 2001]);
  const pair = argValue('pair') || 'active200-current';
  const targeted = process.argv.includes('--targeted');
  const rows = candidateRules(pair, { targeted }).map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows.slice(0, 40)) {
    console.log(`${row.name.padEnd(26)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeModalRescueConfig,
  stateFeatures,
  CONFIGS,
};
