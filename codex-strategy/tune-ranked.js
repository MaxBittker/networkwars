'use strict';

const sim = require('../sim');
const { FAST_DEFAULTS, TUNED_RANKED_OPTIONS, makeRankedStrategy } = require('./strategy');

const attempts = Number(process.argv[2]) || 120;
const games = Number(process.argv[3]) || 300;
const seedBase = Number(process.argv[4]) || 1;

function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

function jitter(rng, base, span, min = 0) {
  return Math.max(min, base + between(rng, -span, span));
}

function candidate(rng, anchor) {
  return {
    threshold: jitter(rng, anchor.threshold, 55, 20),
    capture: jitter(rng, anchor.capture, 70, 20),
    weakTarget: jitter(rng, anchor.weakTarget, 38, 0),
    margin: jitter(rng, anchor.margin, 11, -12),
    source: jitter(rng, anchor.source, 12, -12),
    redAdj: jitter(rng, anchor.redAdj, 35, 0),
    merge: jitter(rng, anchor.merge, 55, 0),
    largestTouch: jitter(rng, anchor.largestTouch, 45, 0),
    enemyCount: jitter(rng, anchor.enemyCount, 10, 0),
    eliminate: jitter(rng, anchor.eliminate, 140, 0),
    exposure: jitter(rng, anchor.exposure, 28, 0),
    lowChancePenalty: jitter(rng, anchor.lowChancePenalty, 90, 0),
    strongTargetPenalty: jitter(rng, anchor.strongTargetPenalty, 12, 0),
    maxAttacks: 120,
  };
}

const anchors = [
  TUNED_RANKED_OPTIONS,
  FAST_DEFAULTS,
  {
    ...FAST_DEFAULTS,
    threshold: 135,
    capture: 150,
    redAdj: 44,
    merge: 85,
    largestTouch: 58,
    exposure: 25,
    enemyCount: 2,
  },
  {
    ...FAST_DEFAULTS,
    threshold: 70,
    capture: 110,
    weakTarget: 45,
    margin: 3,
    redAdj: 15,
    merge: 20,
    exposure: 4,
    lowChancePenalty: 18,
  },
];

const rng = makeRng(0xC0D3CAFE);
const results = [];

console.log(`Tuning ${attempts} candidates over ${games} games each, seeds ${seedBase}..${seedBase + games - 1}`);

for (let i = 0; i < attempts; i++) {
  const anchor = anchors[Math.floor(rng() * anchors.length)];
  const options = i < anchors.length ? anchors[i] : candidate(rng, anchor);
  const result = sim.scorePolicy(makeRankedStrategy(options), { games, seedBase });
  results.push({ options, result });
  results.sort((a, b) => b.result.winRate - a.result.winRate || a.result.avgGameLength - b.result.avgGameLength);
  results.length = Math.min(results.length, 12);

  const best = results[0];
  console.log(
    `${String(i + 1).padStart(4)}/${attempts}`,
    `${(result.winRate * 100).toFixed(1).padStart(5)}%`,
    'best',
    `${(best.result.winRate * 100).toFixed(1)}%`,
  );
}

console.log('\nTop candidates:\n');
for (const item of results) {
  console.log(JSON.stringify({
    winRate: Number((item.result.winRate * 100).toFixed(2)),
    wins: item.result.wins,
    games: item.result.games,
    avgTurnsToWin: item.result.avgTurnsToWin && Number(item.result.avgTurnsToWin.toFixed(2)),
    avgGameLength: Number(item.result.avgGameLength.toFixed(2)),
    options: Object.fromEntries(Object.entries(item.options).map(([k, v]) => [k, Number(v.toFixed ? v.toFixed(3) : v)])),
  }));
}
