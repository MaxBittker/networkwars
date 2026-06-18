'use strict';

// Strict scratch experiment: codexPressure plus a visible bias toward removing
// low-count factions from the game. No api.rng(), no seed recovery, no mutation.

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
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    if (codex.captureProbability(from.strength, to.strength) > 0.4) ok++;
  }
  return ok;
}

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function makeEliminatePressure({
  threshold = 13,
  highOpportunity = codex.C1_RANKED_OPTIONS,
  fallback = codex.C4_RANKED_OPTIONS,
  leaderBonus = 13,
  endDrop = 14,
  weakCut = 3,
  weakBonus = 0,
  lastBonus = 0,
  nonLeaderWeakScale = 1,
  maxAttacks = 120,
} = {}) {
  const highOptions = { ...codex.FAST_DEFAULTS, ...highOpportunity };
  const fallbackOptions = { ...codex.FAST_DEFAULTS, ...fallback };
  let mode = null;

  return function eliminatePressure(api) {
    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (mode === null || isOpening(state)) {
        mode = openingOkCount(state) >= threshold ? 'high' : 'fallback';
      }

      const options = mode === 'high' ? highOptions : fallbackOptions;
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

        if (c[to.owner] <= weakCut) {
          const scale = c[to.owner] === maxEnemy ? 1 : nonLeaderWeakScale;
          score += weakBonus * (weakCut + 1 - c[to.owner]) * scale;
        }
        if (c[to.owner] === 1) score += lastBonus;

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
  const games = Number(process.argv[2]) || 200;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const candidates = [
    ['pressure', () => codex.makePressureStrategy()],
  ];
  for (const weakCut of [2, 3, 4]) {
    for (const weakBonus of [8, 16, 28, 44]) {
      for (const lastBonus of [0, 50, 100, 160]) {
        for (const nonLeaderWeakScale of [0.5, 1, 1.5]) {
          const name = `c${weakCut}/w${weakBonus}/l${lastBonus}/s${nonLeaderWeakScale}`;
          candidates.push([name, () => makeEliminatePressure({
            weakCut,
            weakBonus,
            lastBonus,
            nonLeaderWeakScale,
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
    console.log(`${row.name.padEnd(20)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeEliminatePressure };
