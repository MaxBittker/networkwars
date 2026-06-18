'use strict';

// Strict scratch experiment: codexPressure with a bounded first-turn push.
// It uses visible state only and legal api.attack(...) calls.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];

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

function legalMoves(state) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== 'red' || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) if (state.nodes[to].owner !== 'red') moves.push({ from: n.id, to });
  }
  return moves;
}

function openingOkCount(state) {
  let ok = 0;
  for (const move of legalMoves(state)) {
    if (codex.captureProbability(state.nodes[move.from].strength, state.nodes[move.to].strength) > 0.4) ok++;
  }
  return ok;
}

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function bestPressureItem(state, options, leaderBonus) {
  const c = counts(state);
  const enemyCounts = BOTS.map(f => c[f]).sort((a, b) => b - a);
  const maxEnemy = enemyCounts[0];
  const secondEnemy = enemyCounts[1];
  let best = null;
  let bestScore = -Infinity;
  for (const item of codex.rankedMoveScores(state, options)) {
    const to = state.nodes[item.move.to];
    let score = item.score;
    if (c[to.owner] === maxEnemy) {
      const leaderGap = Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1);
      score += leaderBonus * leaderGap;
    }
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best && { move: best.move, score: bestScore };
}

function makeOpeningPushPressure({
  threshold = 13,
  highOpportunity = codex.C1_RANKED_OPTIONS,
  fallback = codex.C4_RANKED_OPTIONS,
  leaderBonus = 13,
  endDrop = 14,
  openingOkMax = 8,
  minOpeningAttacks = 0,
  openingDrop = 0,
  openingFloor = 0.25,
  maxAttacks = 120,
} = {}) {
  const highOptions = { ...codex.FAST_DEFAULTS, ...highOpportunity };
  const fallbackOptions = { ...codex.FAST_DEFAULTS, ...fallback };
  let mode = null;
  let pushedThisGame = false;

  return function openingPushPressure(api) {
    let openingPush = false;
    let openingAttacks = 0;
    let openingOk = Infinity;

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (mode === null || isOpening(state)) {
        openingOk = openingOkCount(state);
        mode = openingOk >= threshold ? 'high' : 'fallback';
        pushedThisGame = false;
        openingPush = openingOk <= openingOkMax;
      }

      const options = mode === 'high' ? highOptions : fallbackOptions;
      const c = counts(state);
      if (c.red >= 24) return;

      const item = bestPressureItem(state, options, leaderBonus);
      if (!item) return;
      const from = state.nodes[item.move.from];
      const to = state.nodes[item.move.to];
      const pCap = codex.captureProbability(from.strength, to.strength);
      const normalThreshold = options.threshold - Math.max(0, c.red - 14) * endDrop;

      let thresholdNow = normalThreshold;
      if (!pushedThisGame && openingPush) {
        thresholdNow = Math.min(thresholdNow, options.threshold - openingDrop);
        if (openingAttacks < minOpeningAttacks) thresholdNow = Math.min(thresholdNow, item.score);
      }

      if (item.score < thresholdNow || pCap < openingFloor) return;
      api.attack(item.move.from, item.move.to);
      if (!pushedThisGame && openingPush) {
        openingAttacks++;
        if (openingAttacks >= minOpeningAttacks && item.score < normalThreshold) pushedThisGame = true;
      }
    }
  };
}

function main() {
  const games = Number(process.argv[2]) || 200;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const candidates = [
    ['pressure', () => codex.makePressureStrategy()],
  ];
  for (const openingOkMax of [4, 8, 12]) {
    for (const minOpeningAttacks of [0, 1, 2, 3]) {
      for (const openingDrop of [20, 45, 80, 130]) {
        for (const openingFloor of [0.15, 0.25, 0.35]) {
          const name = `ok${openingOkMax}/m${minOpeningAttacks}/d${openingDrop}/f${openingFloor}`;
          candidates.push([name, () => makeOpeningPushPressure({
            openingOkMax,
            minOpeningAttacks,
            openingDrop,
            openingFloor,
          })]);
        }
      }
    }
  }

  const rows = [];
  for (const [name, factory] of candidates) {
    let total = 0;
    let ms = 0;
    const parts = [];
    for (const seedBase of seedBases) {
      const r = sim.scorePolicy(factory(), { games, seedBase });
      total += r.wins;
      ms += r.totalMs;
      parts.push(`${seedBase}:${r.wins}/${games}`);
    }
    rows.push({ name, total, parts, msPerGame: ms / (games * seedBases.length) });
  }
  rows.sort((a, b) => b.total - a.total);
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.name.padEnd(22)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeOpeningPushPressure };
