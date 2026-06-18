'use strict';

// Strict local tuner for codexSafetyK2. This only varies public-state scoring
// weights on the existing top-two exact safety evaluator; it does not call
// api.rng(), recover seeds, mutate live nodes, or use cross-game state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const BASE = {
  minScore: 210,
  splitWeight: 25,
};

const DEFAULTS = {
  safetyWeight: 45,
  threatenedWeight: 16,
  countWeight: 4,
  redGainWeight: 28,
  largestWeight: 22,
  strengthWeight: 2,
  splitWeight: 35,
  enemyWeight: 18,
};

function nameFor(options) {
  const keys = Object.keys(options).sort();
  if (!keys.length) return 'base';
  return keys.map(k => `${k}=${options[k]}`).join(',');
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const options of candidates) {
    const merged = { ...BASE, ...options };
    const name = nameFor(merged);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push([name, merged]);
  }
  return out;
}

function oneAtATimeCandidates() {
  const candidates = [{}];
  const axes = {
    minScore: [180, 190, 200, 205, 210, 215, 220, 230],
    safetyWeight: [25, 35, 45, 55, 65],
    threatenedWeight: [0, 8, 16, 24, 36],
    countWeight: [0, 2, 4, 6, 10],
    redGainWeight: [16, 24, 28, 32, 40, 52],
    largestWeight: [10, 18, 22, 26, 34, 46],
    strengthWeight: [0, 1, 2, 3, 5, 8],
    splitWeight: [0, 10, 20, 25, 30, 40, 50, 65],
    enemyWeight: [6, 12, 18, 24, 32, 44],
  };

  for (const [key, values] of Object.entries(axes)) {
    for (const value of values) {
      const current = key in BASE ? BASE[key] : DEFAULTS[key];
      if (value === current) continue;
      candidates.push({ [key]: value });
    }
  }

  for (const minScore of [195, 205, 210, 215, 225]) {
    for (const splitWeight of [15, 20, 25, 30, 35, 45]) {
      candidates.push({ minScore, splitWeight });
    }
  }

  return uniqueCandidates(candidates);
}

function scoreCandidate(options, games, bases) {
  let total = 0;
  let totalMs = 0;
  const parts = [];
  for (const seedBase of bases) {
    const result = sim.scorePolicy(codex.makeSafetyK2Strategy(options), { games, seedBase });
    total += result.wins;
    totalMs += result.totalMs;
    parts.push(`${seedBase}:${result.wins}/${games}`);
  }
  return {
    total,
    games: games * bases.length,
    parts,
    msPerGame: totalMs / (games * bases.length),
  };
}

function main() {
  const games = Number(process.argv[2]) || 40;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 10001);

  const rows = [];
  for (const [name, options] of oneAtATimeCandidates()) {
    const result = scoreCandidate(options, games, bases);
    rows.push({ name, options, ...result });
  }

  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows.slice(0, 25)) {
    console.log(`${row.name.padEnd(42)} ${String(row.total).padStart(4)}/${row.games}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { oneAtATimeCandidates, scoreCandidate };
