'use strict';

// Strict scratch experiment: keep the current gap-triggered exact-safety
// strategy shape, but vary one ranked move-ordering weight at a time. No
// api.rng(), seed recovery, board lookup tables, live-node mutation, or
// benchmark-order state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

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
  capture: [15, 22, 28.795, 36, 48, 64],
  redAdj: [45, 58, 68.557, 82, 100],
  merge: [150, 170, 185, 200, 220],
  largestTouch: [0, 8, 11.775, 20, 35, 55],
  enemyCount: [8, 16, 25.161, 36, 50],
  exposure: [60, 82, 103.136, 125, 155],
  lowChancePenalty: [140, 180, 216.851, 255, 310],
  strongTargetPenalty: [0, 2, 4.551, 8, 14],
  threshold: [210, 225, 235, 245, 260],
};

function makeCandidate(name, options) {
  return [name, () => codex.makeGapThreatSafetyStrategy({
    rankedOptions: options,
    topK: 6,
    countWeight: 14,
    openingOptions: { riskWeight: 75 },
  })];
}

function candidates(mode) {
  const base = codex.DELAYED_MERGE_RANKED_OPTIONS;
  const out = [makeCandidate('current', base)];
  const axes = mode && mode !== 'all' ? { [mode]: AXES[mode] } : AXES;
  for (const [axis, values] of Object.entries(axes)) {
    if (!values) throw new Error(`unknown axis: ${axis}`);
    for (const value of values) {
      if (value === base[axis]) continue;
      out.push(makeCandidate(`${axis}=${value}`, { ...base, [axis]: value }));
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
  const games = Number(argValue('games')) || 160;
  const bases = parseList(argValue('bases'), [1, 1001, 2001, 10001, 50001]);
  const mode = argValue('axis') || 'all';
  const rows = candidates(mode).map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows.slice(0, 40)) {
    console.log(`${row.name.padEnd(24)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  candidates,
};
