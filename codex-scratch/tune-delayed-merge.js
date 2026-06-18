'use strict';

// Strict scratch tuner for the current best simple family:
// wait one RED turn, then use one fixed ranked scoring policy.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

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

function roundedOptions(options) {
  return Object.fromEntries(Object.entries(options).map(([k, v]) => [
    k,
    Number(v.toFixed ? v.toFixed(3) : v),
  ]));
}

function candidate(rng, anchor) {
  return {
    threshold: jitter(rng, anchor.threshold, 42, 80),
    capture: jitter(rng, anchor.capture, 55, -40),
    weakTarget: jitter(rng, anchor.weakTarget, 30, 0),
    margin: jitter(rng, anchor.margin, 13, -15),
    source: jitter(rng, anchor.source, 13, -15),
    redAdj: jitter(rng, anchor.redAdj, 55, 0),
    merge: jitter(rng, anchor.merge, 80, 0),
    largestTouch: jitter(rng, anchor.largestTouch, 55, 0),
    enemyCount: jitter(rng, anchor.enemyCount, 22, 0),
    eliminate: jitter(rng, anchor.eliminate, 120, 0),
    exposure: jitter(rng, anchor.exposure, 70, 0),
    lowChancePenalty: jitter(rng, anchor.lowChancePenalty, 115, 0),
    strongTargetPenalty: jitter(rng, anchor.strongTargetPenalty, 14, 0),
    maxAttacks: 120,
  };
}

function score(options, games, bases) {
  let wins = 0;
  let totalMs = 0;
  const parts = [];
  for (const seedBase of bases) {
    const r = sim.scorePolicy(
      codex.makeDelayedRankedStrategy(options),
      { games, seedBase },
    );
    wins += r.wins;
    totalMs += r.totalMs;
    parts.push(`${seedBase}:${r.wins}/${games}`);
  }
  return { wins, parts, msPerGame: totalMs / (games * bases.length) };
}

function main() {
  const attempts = Number(process.argv[2]) || 160;
  const games = Number(process.argv[3]) || 120;
  const bases = process.argv.slice(4).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 2001, 10001, 50001);

  const rng = makeRng(0xD31A7E55);
  const anchors = [
    codex.DELAYED_MERGE_RANKED_OPTIONS,
    { ...codex.DELAYED_MERGE_RANKED_OPTIONS, threshold: 235, merge: 175 },
    { ...codex.DELAYED_MERGE_RANKED_OPTIONS, threshold: 230, merge: 185 },
    { ...codex.DELAYED_MERGE_RANKED_OPTIONS, capture: 65 },
    { ...codex.DELAYED_MERGE_RANKED_OPTIONS, enemyCount: 35 },
  ];

  const candidates = [
    ['baseline', codex.DELAYED_MERGE_RANKED_OPTIONS],
    ['t235m175', { ...codex.DELAYED_MERGE_RANKED_OPTIONS, threshold: 235, merge: 175 }],
    ['t230m185', { ...codex.DELAYED_MERGE_RANKED_OPTIONS, threshold: 230, merge: 185 }],
  ];

  for (let i = 0; i < attempts; i++) {
    const anchor = anchors[Math.floor(rng() * anchors.length)];
    candidates.push([`rand${i}`, candidate(rng, anchor)]);
  }

  const rows = [];
  for (const [name, options] of candidates) {
    const result = score(options, games, bases);
    rows.push({ name, options, ...result });
    rows.sort((a, b) => b.wins - a.wins);
    rows.length = Math.min(rows.length, 20);
  }

  console.log(`screen games=${games} bases=${bases.join(',')} candidates=${candidates.length}`);
  for (const row of rows.slice(0, 20)) {
    console.log(`${row.name.padEnd(10)} ${String(row.wins).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
    console.log(JSON.stringify(roundedOptions(row.options)));
  }
}

if (require.main === module) main();

