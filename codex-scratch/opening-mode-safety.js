'use strict';

// Strict scratch experiment: keep the SafetyK2 midgame but vary only the first
// RED turn. No api.rng(), seed recovery, live-node mutation, board fingerprints,
// or benchmark-order state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
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

function safetyMove(state, options = {}) {
  return codex.selectSafetyRankedMove(state, {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    minScore: 210,
    splitWeight: 25,
    ...options,
  });
}

function runSafetyTurn(api, { maxAttacks = 120, safetyOptions = {} } = {}) {
  for (let attacks = 0; attacks < maxAttacks; attacks++) {
    const state = cloneFromApi(api);
    if (counts(state).red >= WIN_NODES) return;
    const move = safetyMove(state, safetyOptions);
    if (!move) return;
    api.attack(move.from, move.to);
  }
}

function openingDefenseMove(state, openingOptions = {}) {
  return codex.selectOpeningDefenseMove(state, {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    minP: 0.55,
    minScore: 60,
    riskWeight: 55,
    ...openingOptions,
  });
}

function makeOpeningModeSafety({
  mode = 'baseline',
  maxOpeningAttacks = 2,
  openingOptions = {},
  safetyOptions = {},
  maxAttacks = 120,
} = {}) {
  if (mode === 'baseline') {
    return codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, ...safetyOptions });
  }
  if (mode === 'threat36') {
    return codex.makeSafetyK2Strategy({
      minScore: 210,
      splitWeight: 25,
      threatenedWeight: 36,
      ...safetyOptions,
    });
  }
  if (mode === 'pass') {
    return codex.makeSafetyK2Strategy({
      maxOpeningAttacks: 0,
      minScore: 210,
      splitWeight: 25,
      ...safetyOptions,
    });
  }

  let openingHandled = false;
  return function openingModeSafety(api) {
    const initial = cloneFromApi(api);
    const opening = isOpening(initial);
    if (opening) openingHandled = false;

    if (!openingHandled && opening) {
      openingHandled = true;
      if (mode === 'immediate') {
        runSafetyTurn(api, { maxAttacks, safetyOptions });
        return;
      }

      if (mode === 'defenseStop' || mode === 'defenseContinue') {
        for (let i = 0; i < maxOpeningAttacks; i++) {
          const state = cloneFromApi(api);
          const move = openingDefenseMove(state, openingOptions);
          if (!move) return;
          api.attack(move.from, move.to);
        }
        if (mode === 'defenseStop') return;
        runSafetyTurn(api, { maxAttacks, safetyOptions });
        return;
      }
    }

    runSafetyTurn(api, { maxAttacks, safetyOptions });
  };
}

const candidateFactories = {
  baseline: () => makeOpeningModeSafety({ mode: 'baseline' }),
  threat36: () => makeOpeningModeSafety({ mode: 'threat36' }),
  pass: () => makeOpeningModeSafety({ mode: 'pass' }),
  immediate: () => makeOpeningModeSafety({ mode: 'immediate' }),
  defenseContinue1: () => makeOpeningModeSafety({ mode: 'defenseContinue', maxOpeningAttacks: 1 }),
  defenseContinue2: () => makeOpeningModeSafety({ mode: 'defenseContinue', maxOpeningAttacks: 2 }),
  defenseContinue3: () => makeOpeningModeSafety({ mode: 'defenseContinue', maxOpeningAttacks: 3 }),
  looseContinue: () => makeOpeningModeSafety({
    mode: 'defenseContinue',
    maxOpeningAttacks: 3,
    openingOptions: { minP: 0.45, minScore: 40 },
  }),
  threatContinue: () => makeOpeningModeSafety({
    mode: 'defenseContinue',
    maxOpeningAttacks: 2,
    safetyOptions: { threatenedWeight: 36 },
  }),
};

function main() {
  const games = Number(process.argv[2]) || 120;
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
    console.log(`${row.name.padEnd(18)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeOpeningModeSafety,
};
