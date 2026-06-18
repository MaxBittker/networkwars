'use strict';

// Scratch validator for strict pressure variants. Imports generated ranked
// option arrays only; it does not call seedOracleStrategy, recoverSeed, or
// api.rng().

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');
const seedOracle = require('../codex-strategy/seed-oracle');

const byName = new Map([
  ['C1', codex.C1_RANKED_OPTIONS],
  ['C4', codex.C4_RANKED_OPTIONS],
  ['legacy', codex.LEGACY_TUNED_RANKED_OPTIONS],
  ['tuned', codex.TUNED_RANKED_OPTIONS],
  ...seedOracle.GENERATED_RANKED_OPTIONS,
  ...seedOracle.TARGETED_RANKED_OPTIONS,
]);

const candidates = [
  ['baseline', () => codex.makePressureStrategy()],
  ['screenTop', () => codex.makePressureStrategy({
    threshold: 12,
    highOpportunity: byName.get('rankedRand.139'),
    fallback: byName.get('targetRand.7.284'),
    leaderBonus: 10,
    endDrop: 6,
  })],
  ['legacyC4', () => codex.makePressureStrategy({
    threshold: 10,
    highOpportunity: byName.get('legacy'),
    fallback: byName.get('C4'),
    leaderBonus: 16,
    endDrop: 10,
  })],
  ['legacy139', () => codex.makePressureStrategy({
    threshold: 10,
    highOpportunity: byName.get('legacy'),
    fallback: byName.get('rankedRand.139'),
    leaderBonus: 22,
    endDrop: 6,
  })],
  ['tunedC1', () => codex.makePressureStrategy({
    threshold: 8,
    highOpportunity: byName.get('tuned'),
    fallback: byName.get('C1'),
    leaderBonus: 16,
    endDrop: 14,
  })],
];

const games = Number(process.argv[2]) || 500;
const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
if (!seedBases.length) seedBases.push(1, 1001, 2001, 10001, 50001);

for (const [name, factory] of candidates) {
  let total = 0;
  const parts = [];
  for (const seedBase of seedBases) {
    const policy = factory();
    const r = sim.scorePolicy(policy, { games, seedBase });
    total += r.wins;
    parts.push(`${seedBase}:${r.wins}/${games}`);
  }
  console.log(`${name.padEnd(12)} ${String(total).padStart(5)}/${games * seedBases.length}  ${parts.join('  ')}`);
}
