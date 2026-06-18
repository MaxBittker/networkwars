'use strict';

// Strict scratch experiment: keep the validated modal opening and exact-safety
// move selector, but stop a RED turn after a small number of successful captures
// in fragile states so reinforcement happens before further overextension.
// No api.rng(), seed recovery, board lookup, live-node mutation, or
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

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
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

function stateFeatures(state) {
  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  let risk = 0;
  let threatened = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const nb of state.adj[n.id]) {
      const target = state.nodes[nb];
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
    risk,
    threatened,
  };
}

function captureBudget(features, {
  earlyRed = 10,
  midRed = 16,
  earlyBudget = 1,
  midBudget = 2,
  lateBudget = 99,
  gapCut = 5,
  riskCut = 3.5,
  fragileBudget = 1,
} = {}) {
  if (features.red >= WIN_NODES - 1) return 99;
  if (features.gap >= gapCut || features.risk >= riskCut) return fragileBudget;
  if (features.red <= earlyRed || features.largest <= earlyRed) return earlyBudget;
  if (features.red <= midRed) return midBudget;
  return lateBudget;
}

function safetyMove(state, safetyOptions = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  return codex.selectSafetyRankedMove(state, {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    topK: 6,
    countWeight: 14,
    minScore: 210,
    splitWeight: 25,
    threatenedWeight: maxEnemy - c.red >= 2 ? 36 : 16,
    ...safetyOptions,
  });
}

function makeModalCaptureBudget({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  budgetOptions = {},
  safetyOptions = {},
} = {}) {
  let openingHandled = false;

  return function modalCaptureBudget(api) {
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

    const start = cloneFromApi(api);
    const budget = captureBudget(stateFeatures(start), budgetOptions);
    let captures = 0;

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = safetyMove(state, safetyOptions);
      if (!move) return;
      const result = api.attack(move.from, move.to);
      if (result && result.captured) captures++;
      if (captures >= budget) return;
    }
  };
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map(Number).filter(Number.isFinite);
}

function argValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function candidates() {
  return [
    ['modal', () => codex.codexModalOpeningGap],
    ['cap111', () => makeModalCaptureBudget({
      budgetOptions: { earlyRed: 10, midRed: 16, earlyBudget: 1, midBudget: 1, fragileBudget: 1 },
    })],
    ['cap122', () => makeModalCaptureBudget({
      budgetOptions: { earlyRed: 10, midRed: 16, earlyBudget: 1, midBudget: 2, fragileBudget: 2 },
    })],
    ['cap123', () => makeModalCaptureBudget({
      budgetOptions: { earlyRed: 10, midRed: 16, earlyBudget: 1, midBudget: 2, fragileBudget: 3 },
    })],
    ['early2', () => makeModalCaptureBudget({
      budgetOptions: { earlyRed: 8, midRed: 14, earlyBudget: 2, midBudget: 3, fragileBudget: 1 },
    })],
    ['riskOnly', () => makeModalCaptureBudget({
      budgetOptions: { earlyRed: 0, midRed: 0, earlyBudget: 99, midBudget: 99, gapCut: 5, riskCut: 3.5, fragileBudget: 1 },
    })],
    ['gentle', () => makeModalCaptureBudget({
      budgetOptions: { earlyRed: 8, midRed: 14, earlyBudget: 2, midBudget: 4, fragileBudget: 2 },
    })],
    ['strictEarly', () => makeModalCaptureBudget({
      budgetOptions: { earlyRed: 12, midRed: 18, earlyBudget: 1, midBudget: 2, fragileBudget: 1, riskCut: 2.5 },
    })],
  ];
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
  const rows = candidates().map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows) {
    console.log(`${row.name.padEnd(12)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeModalCaptureBudget,
  captureBudget,
};
