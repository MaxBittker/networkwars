'use strict';

// Strict scratch experiment: tune the opening-only modal bot-round scorer around
// codexModalOpeningGap. It keeps the production midgame fixed and varies one
// opening weight at a time. No api.rng(), seed recovery, board lookup tables,
// live-node mutation, or benchmark-order state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');
const modal = require('./modal-bot-round');

function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map(Number).filter(Number.isFinite);
}

function argValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const AXES = {
  minP: [0.45, 0.5, 0.55, 0.6, 0.65],
  minScore: [20, 30, 40, 50, 65, 80],
  redGainWeight: [36, 48, 60, 72, 90],
  largestWeight: [0, 14, 28, 42, 56],
  strengthWeight: [0, 0.5, 1, 2, 4],
  splitWeight: [0, 10, 20, 35, 50],
  enemyWeight: [0, 7, 14, 24, 36],
  riskWeight: [0, 9, 18, 30, 45],
  countWeight: [0, 3, 6, 10, 16],
  threatenedWeight: [0, 6, 12, 20, 32],
  rankedWeight: [0, 0.01, 0.02, 0.04, 0.08],
};

const DEFAULTS = {
  minP: 0.55,
  minScore: 40,
  redGainWeight: 60,
  largestWeight: 28,
  strengthWeight: 1,
  splitWeight: 20,
  enemyWeight: 14,
  riskWeight: 18,
  countWeight: 6,
  threatenedWeight: 12,
  rankedWeight: 0.02,
};

function candidates(axis) {
  const axes = axis && axis !== 'all' ? { [axis]: AXES[axis] } : AXES;
  const out = [
    ['prod', () => codex.codexModalOpeningGap],
    ['scratchDefault', () => modal.makeModalOpeningGapStrategy()],
  ];
  for (const [name, values] of Object.entries(axes)) {
    if (!values) throw new Error(`unknown axis: ${name}`);
    for (const value of values) {
      if (value === DEFAULTS[name]) continue;
      out.push([
        `${name}=${value}`,
        () => modal.makeModalOpeningGapStrategy({ openingOptions: { [name]: value } }),
      ]);
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
  return { name, total, totalGames: games * bases.length, parts, msPerGame: totalMs / (games * bases.length) };
}

function main() {
  const games = Number(argValue('games')) || 120;
  const bases = parseList(argValue('bases'), [1, 1001, 2001]);
  const axis = argValue('axis') || 'all';
  const rows = candidates(axis).map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.name.padEnd(24)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { candidates };
