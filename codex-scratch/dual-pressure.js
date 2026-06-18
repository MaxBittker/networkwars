'use strict';

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

function makeDualPressure({
  optionSets = [
    codex.C1_RANKED_OPTIONS,
    codex.C4_RANKED_OPTIONS,
  ],
  leaderBonus = 13,
  endDrop = 14,
  minMargin = 0,
  maxAttacks = 120,
} = {}) {
  const optionsList = optionSets.map(options => ({ ...codex.FAST_DEFAULTS, ...options }));

  return function dualPressure(api) {
    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= 24) return;

      const enemyCounts = BOTS.map(f => c[f]).sort((a, b) => b - a);
      const maxEnemy = enemyCounts[0];
      const secondEnemy = enemyCounts[1];

      let best = null;
      let bestMargin = -Infinity;

      for (const options of optionsList) {
        const threshold = options.threshold - Math.max(0, c.red - 14) * endDrop;
        for (const item of codex.rankedMoveScores(state, options).slice(0, 4)) {
          const to = state.nodes[item.move.to];
          let score = item.score;
          if (c[to.owner] === maxEnemy) {
            const leaderGap = Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1);
            score += leaderBonus * leaderGap;
          }
          const margin = score - threshold;
          if (margin > bestMargin) {
            best = item.move;
            bestMargin = margin;
          }
        }
      }

      if (!best || bestMargin < minMargin) return;
      api.attack(best.from, best.to);
    }
  };
}

function main() {
  const games = Number(process.argv[2]) || 200;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const candidates = {
    pressure: () => codex.makePressureStrategy(),
    dual: () => makeDualPressure(),
    dualLegacy: () => makeDualPressure({
      optionSets: [codex.C1_RANKED_OPTIONS, codex.C4_RANKED_OPTIONS, codex.LEGACY_TUNED_RANKED_OPTIONS],
    }),
    dualAggro: () => makeDualPressure({ minMargin: -18 }),
    dualCautious: () => makeDualPressure({ minMargin: 12 }),
    dualLeader: () => makeDualPressure({ leaderBonus: 20 }),
  };

  const rows = [];
  for (const [name, factory] of Object.entries(candidates)) {
    let total = 0;
    const parts = [];
    let ms = 0;
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
    console.log(`${row.name.padEnd(12)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeDualPressure };
