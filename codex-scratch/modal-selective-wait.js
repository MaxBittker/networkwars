'use strict';

// Strict scratch experiment: keep the validated modal opening and exact-safety
// midgame, but occasionally pass a later RED turn when RED reinforcement alone
// is predicted to materially reduce visible risk and the bot leader is not
// already running away. No api.rng(), seed recovery, board lookup, live-node
// mutation, or benchmark-order state.

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
  for (let i = 0; i < largest.length; i++) state.nodes[border[i % border.length]].strength++;
}

function riskStats(state) {
  let risk = 0;
  let threatened = 0;
  let beatable = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const nb of state.adj[n.id]) {
      const target = state.nodes[nb];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      risk += p;
      beatable++;
      if (p > 0.45) threatened++;
    }
  }
  return { risk, threatened, beatable };
}

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function waitValue(state, {
  minRed = 7,
  maxRed = 18,
  maxGap = 3,
  minCurrentRisk = 1.8,
  maxReinforcedRisk = 2.5,
  minRiskDrop = 1.0,
  minRiskDropRatio = 0.35,
  maxThreatenedAfter = 3,
  requireConnected = false,
} = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  if (c.red < minRed || c.red > maxRed || maxEnemy - c.red > maxGap) return false;
  if (requireConnected && largest < c.red - 1) return false;

  const before = riskStats(state);
  const afterState = cloneState(state);
  reinforce(afterState, HUMAN);
  const after = riskStats(afterState);
  const drop = before.risk - after.risk;

  return before.risk >= minCurrentRisk
    && after.risk <= maxReinforcedRisk
    && after.threatened <= maxThreatenedAfter
    && drop >= minRiskDrop
    && drop >= before.risk * minRiskDropRatio;
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

function makeModalSelectiveWait({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  waitBudget = 1,
  waitOptions = {},
  safetyOptions = {},
} = {}) {
  let openingHandled = false;
  let waitsRemaining = waitBudget;

  return function modalSelectiveWait(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) {
      openingHandled = false;
      waitsRemaining = waitBudget;
    }

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

    if (waitsRemaining > 0 && waitValue(initial, waitOptions)) {
      waitsRemaining--;
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = safetyMove(state, safetyOptions);
      if (!move) return;
      api.attack(move.from, move.to);
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
    ['riskDrop', () => makeModalSelectiveWait()],
    ['riskDrop2', () => makeModalSelectiveWait({ waitBudget: 2 })],
    ['tight', () => makeModalSelectiveWait({
      waitOptions: { minRed: 8, maxRed: 16, maxGap: 1, minCurrentRisk: 2.5, maxReinforcedRisk: 1.5, minRiskDrop: 1.5 },
    })],
    ['loose', () => makeModalSelectiveWait({
      waitOptions: { minRed: 6, maxRed: 20, maxGap: 4, minCurrentRisk: 1.2, maxReinforcedRisk: 3.2, minRiskDrop: 0.6, minRiskDropRatio: 0.25, maxThreatenedAfter: 4 },
    })],
    ['connected', () => makeModalSelectiveWait({
      waitOptions: { requireConnected: true, minRed: 8, maxRed: 18, maxGap: 2, minCurrentRisk: 1.5, maxReinforcedRisk: 2.2 },
    })],
    ['earlyOnly', () => makeModalSelectiveWait({
      waitOptions: { minRed: 7, maxRed: 12, maxGap: 2, minCurrentRisk: 1.4, maxReinforcedRisk: 2.0, minRiskDrop: 0.7 },
    })],
    ['lateOnly', () => makeModalSelectiveWait({
      waitOptions: { minRed: 13, maxRed: 20, maxGap: 2, minCurrentRisk: 2.0, maxReinforcedRisk: 2.5, minRiskDrop: 1.0 },
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
  makeModalSelectiveWait,
  waitValue,
};
