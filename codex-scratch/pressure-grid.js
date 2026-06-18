'use strict';

// Scratch-only strict pressure search. Imports generated ranked option arrays
// from seed-oracle.js, but does not call seedOracleStrategy, recoverSeed, or
// api.rng(); policies use only visible board state and legal api.attack(...).

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');
const seedOracle = require('../codex-strategy/seed-oracle');

const OPTION_SETS = [
  ['C1', codex.C1_RANKED_OPTIONS],
  ['C4', codex.C4_RANKED_OPTIONS],
  ['legacy', codex.LEGACY_TUNED_RANKED_OPTIONS],
  ['tuned', codex.TUNED_RANKED_OPTIONS],
];

for (const [name, options] of seedOracle.GENERATED_RANKED_OPTIONS) {
  if ([
    'rankedRand.16',
    'rankedRand.35',
    'rankedRand.139',
    'rankedRand.187',
    'rankedRand.226',
  ].includes(name)) OPTION_SETS.push([name, options]);
}

for (const [name, options] of seedOracle.TARGETED_RANKED_OPTIONS) {
  if ([
    'targetRand.7.284',
    'targetRand.99.1',
    'targetRand.123456.217',
    'targetRand.314159.266',
  ].includes(name)) OPTION_SETS.push([name, options]);
}

const games = Number(process.argv[2]) || 200;
const seedBases = (process.argv.slice(3).map(Number).filter(Number.isFinite));
if (!seedBases.length) seedBases.push(1, 1001, 10001);
const maxCandidates = Number(process.env.PRESSURE_GRID_LIMIT) || 900;

function rng(seed) {
  let s = seed >>> 0;
  return function next() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function score(factory) {
  let total = 0;
  const parts = [];
  for (const seedBase of seedBases) {
    const policy = factory();
    const r = sim.scorePolicy(policy, { games, seedBase });
    total += r.wins;
    parts.push(`${seedBase}:${r.wins}/${games}`);
  }
  return { total, parts };
}

function main() {
  const rows = [];
  const baseline = score(() => codex.makePressureStrategy());
  rows.push({ name: 'baseline', total: baseline.total, parts: baseline.parts, opts: null });

  const combos = [];
  for (const [hiName, highOpportunity] of OPTION_SETS) {
    for (const [loName, fallback] of OPTION_SETS) {
      for (const threshold of [8, 10, 12, 13, 14, 16]) {
        for (const leaderBonus of [0, 6, 10, 13, 16, 22]) {
          for (const endDrop of [0, 6, 10, 14, 18, 24]) {
            combos.push({
              name: `${hiName}/${loName}/t${threshold}/l${leaderBonus}/e${endDrop}`,
              opts: { threshold, highOpportunity, fallback, leaderBonus, endDrop },
            });
          }
        }
      }
    }
  }

  const rand = rng(20260609);
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }

  for (const combo of combos.slice(0, maxCandidates)) {
    const r = score(() => codex.makePressureStrategy(combo.opts));
    rows.push({
      name: combo.name,
      total: r.total,
      parts: r.parts,
      opts: combo.opts,
    });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.name.padEnd(44)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}`);
  }
}

main();
