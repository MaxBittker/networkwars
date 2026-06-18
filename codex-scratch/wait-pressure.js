'use strict';

// Strict scratch experiment: if RED's opening has few good attacks, skip the
// first RED turn and let bots spend strength, then play pressure normally.

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
    for (const to of state.adj[n.id]) {
      if (state.nodes[to].owner !== 'red') moves.push({ from: n.id, to });
    }
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

function makeWaitPressure({
  threshold = 13,
  waitOkMax = 8,
  waitTurns = 1,
  highOpportunity = codex.C1_RANKED_OPTIONS,
  fallback = codex.C4_RANKED_OPTIONS,
  leaderBonus = 13,
  endDrop = 14,
  maxAttacks = 120,
} = {}) {
  const highOptions = { ...codex.FAST_DEFAULTS, ...highOpportunity };
  const fallbackOptions = { ...codex.FAST_DEFAULTS, ...fallback };
  let mode = null;
  let waitsRemaining = 0;

  return function waitPressure(api) {
    const initial = cloneFromApi(api);
    if (mode === null || isOpening(initial)) {
      const openingOk = openingOkCount(initial);
      mode = openingOk >= threshold ? 'high' : 'fallback';
      waitsRemaining = openingOk <= waitOkMax ? waitTurns : 0;
    }

    if (waitsRemaining > 0) {
      waitsRemaining--;
      return;
    }

    const options = mode === 'high' ? highOptions : fallbackOptions;
    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= 24) return;

      const enemyCounts = BOTS.map(f => c[f]).sort((a, b) => b - a);
      const maxEnemy = enemyCounts[0];
      const secondEnemy = enemyCounts[1];
      const dynamicThreshold = options.threshold - Math.max(0, c.red - 14) * endDrop;

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
          best = item.move;
          bestScore = score;
        }
      }

      if (!best || bestScore < dynamicThreshold) return;
      api.attack(best.from, best.to);
    }
  };
}

function main() {
  const games = Number(process.argv[2]) || 300;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const candidates = {
    pressure: () => codex.makePressureStrategy(),
    wait4: () => makeWaitPressure({ waitOkMax: 4 }),
    wait8: () => makeWaitPressure({ waitOkMax: 8 }),
    wait12: () => makeWaitPressure({ waitOkMax: 12 }),
    wait8x2: () => makeWaitPressure({ waitOkMax: 8, waitTurns: 2 }),
  };

  const rows = [];
  for (const [name, factory] of Object.entries(candidates)) {
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
  for (const row of rows) {
    console.log(`${row.name.padEnd(10)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeWaitPressure };
