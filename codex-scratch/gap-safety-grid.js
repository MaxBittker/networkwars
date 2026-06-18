'use strict';

// Strict scratch harness for nearby variants of the current gap-triggered
// safety strategy. It evaluates legal policies only: no api.rng(), seed
// recovery, board lookup tables, live-node mutation, or benchmark-order state.

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

function defaultCandidates(mode) {
  const out = [
    ['gapFast', () => codex.codexSafetyGap2ThreatFast],
    ['gapCurrent', () => codex.codexSafetyGap2Threat],
  ];

  if (mode === 'topk') {
    for (const topK of [3, 4, 5, 6, 7, 8, 10]) {
      out.push([`k${topK}cw12`, () => codex.makeGapThreatSafetyStrategy({ topK, countWeight: 12 })]);
    }
    for (const topK of [5, 6, 7]) {
      for (const countWeight of [10, 12, 14, 16]) {
        out.push([`k${topK}cw${countWeight}`, () => codex.makeGapThreatSafetyStrategy({ topK, countWeight })]);
      }
    }
    return out;
  }

  if (mode === 'weights') {
    for (const safetyWeight of [35, 45, 55, 65]) {
      out.push([`safe${safetyWeight}`, () => codex.makeGapThreatSafetyStrategy({
        topK: 6,
        countWeight: 14,
        safetyWeight,
      })]);
    }
    for (const redGainWeight of [20, 24, 28, 32, 36, 44]) {
      out.push([`red${redGainWeight}`, () => codex.makeGapThreatSafetyStrategy({
        topK: 6,
        countWeight: 14,
        redGainWeight,
      })]);
    }
    for (const largestWeight of [14, 18, 22, 28, 34]) {
      out.push([`large${largestWeight}`, () => codex.makeGapThreatSafetyStrategy({
        topK: 6,
        countWeight: 14,
        largestWeight,
      })]);
    }
    for (const splitWeight of [15, 20, 25, 30, 35]) {
      out.push([`split${splitWeight}`, () => codex.makeGapThreatSafetyStrategy({
        topK: 6,
        countWeight: 14,
        splitWeight,
      })]);
    }
    for (const minScore of [190, 200, 210, 220, 235]) {
      out.push([`min${minScore}`, () => codex.makeGapThreatSafetyStrategy({
        topK: 6,
        countWeight: 14,
        minScore,
      })]);
    }
    return out;
  }

  for (const topK of [4, 5, 6]) {
    for (const countWeight of [10, 12, 14]) {
      out.push([`k${topK}cw${countWeight}`, () => codex.makeGapThreatSafetyStrategy({ topK, countWeight })]);
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
  return {
    name,
    total,
    totalGames: games * bases.length,
    parts,
    msPerGame: totalMs / (games * bases.length),
  };
}

function main() {
  const games = Number(argValue('games')) || 200;
  const bases = parseList(argValue('bases'), [1, 1001, 2001, 10001, 50001]);
  const mode = argValue('mode') || 'near';
  const candidates = defaultCandidates(mode);

  const rows = [];
  for (const [name, factory] of candidates) {
    rows.push(scoreCandidate(name, factory, games, bases));
  }

  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows) {
    console.log(`${row.name.padEnd(14)} ${String(row.total).padStart(5)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();
