'use strict';

const sim = require('../sim');
const {
  codexStrategy,
  codexC1,
  codexC4,
  codexTuned,
  makeRankedStrategy,
  LEGACY_TUNED_RANKED_OPTIONS,
} = require('./strategy');

const games = Number(process.argv[2]) || 1000;
const seedBase = Number(process.argv[3]) || 1;

const variants = {
  codexStrategy,
  codexC1,
  codexC4,
  codexTuned,
  legacyTuned: makeRankedStrategy(LEGACY_TUNED_RANKED_OPTIONS),
  rankedAggro: makeRankedStrategy({
    threshold: 92,
    capture: 128,
    weakTarget: 34,
    redAdj: 24,
    merge: 45,
    exposure: 10,
    lowChancePenalty: 42,
  }),
  rankedBuilder: makeRankedStrategy({
    threshold: 135,
    capture: 150,
    redAdj: 44,
    merge: 85,
    largestTouch: 58,
    exposure: 25,
    enemyCount: 2,
  }),
  rankedHunter: makeRankedStrategy({
    threshold: 105,
    capture: 138,
    enemyCount: 9,
    eliminate: 160,
    exposure: 12,
    weakTarget: 30,
  }),
  rankedFlood: makeRankedStrategy({
    threshold: 58,
    capture: 92,
    weakTarget: 42,
    margin: 3,
    redAdj: 18,
    merge: 28,
    largestTouch: 20,
    exposure: 5,
    lowChancePenalty: 20,
  }),
};

const policies = {
  ...sim.SAMPLE_POLICIES,
  ...variants,
};

const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log(`\nNetwork Wars strategy benchmark (${games} games, seeds ${seedBase}..${seedBase + games - 1})\n`);
console.log(pad('policy', 18), padl('winrate', 9), padl('wins', 8), padl('avgTurns', 10), padl('avgLen', 8), padl('ms/game', 9));
console.log('-'.repeat(72));

let best = null;
for (const [name, policy] of Object.entries(policies)) {
  const r = sim.scorePolicy(policy, { games, seedBase });
  if (!best || r.winRate > best.result.winRate) best = { name, result: r };
  console.log(
    pad(name, 18),
    padl((r.winRate * 100).toFixed(1) + '%', 9),
    padl(`${r.wins}/${r.games}`, 8),
    padl(r.avgTurnsToWin ? r.avgTurnsToWin.toFixed(2) : '-', 10),
    padl(r.avgGameLength.toFixed(1), 8),
    padl(r.msPerGame.toFixed(2), 9),
  );
}

console.log(`\nBest: ${best.name} (${(best.result.winRate * 100).toFixed(1)}%)\n`);
