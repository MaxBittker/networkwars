'use strict';

// Strict scratch experiment: keep the validated modal opening and exact-safety
// midgame, but stop the current RED turn after failed attacks in fragile states.
// This only reacts to public results from RED's own legal api.attack(...) calls.
// It does not call api.rng(), recover seeds, use board lookup tables, mutate
// live nodes, or track benchmark order.

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

function fragileState(state, {
  redCut = 8,
  gapCut = 4,
  riskCut = 3.0,
  threatenedCut = 3,
} = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const risk = riskStats(state);
  return c.red <= redCut
    || largest <= redCut
    || maxEnemy - c.red >= gapCut
    || risk.risk >= riskCut
    || risk.threatened >= threatenedCut;
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

function makeModalFailureBrake({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  brakeAfterFailures = 1,
  brakeOnlyFragile = true,
  brakeAfterWeakFailure = false,
  fragileOptions = {},
  safetyOptions = {},
} = {}) {
  let openingHandled = false;

  return function modalFailureBrake(api) {
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
    const brakingEnabled = !brakeOnlyFragile || fragileState(start, fragileOptions);
    let failures = 0;

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = safetyMove(state, safetyOptions);
      if (!move) return;

      const fromStrength = state.nodes[move.from].strength;
      const result = api.attack(move.from, move.to);
      if (brakingEnabled && result && !result.captured) {
        failures++;
        const weakFailure = result.fromStrength <= 1 || fromStrength <= 3;
        if (failures >= brakeAfterFailures || (brakeAfterWeakFailure && weakFailure)) return;
      }
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
    ['frag1', () => makeModalFailureBrake()],
    ['frag2', () => makeModalFailureBrake({ brakeAfterFailures: 2 })],
    ['always1', () => makeModalFailureBrake({ brakeOnlyFragile: false })],
    ['weakFail', () => makeModalFailureBrake({ brakeAfterWeakFailure: true })],
    ['tightFrag', () => makeModalFailureBrake({
      fragileOptions: { redCut: 5, gapCut: 6, riskCut: 4.0, threatenedCut: 4 },
    })],
    ['looseFrag', () => makeModalFailureBrake({
      fragileOptions: { redCut: 10, gapCut: 3, riskCut: 2.5, threatenedCut: 2 },
    })],
    ['activeAfterFail', () => makeModalFailureBrake({
      brakeAfterFailures: 1,
      safetyOptions: { minScore: 200, redGainWeight: 34 },
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
    console.log(`${row.name.padEnd(16)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeModalFailureBrake,
  fragileState,
};
