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

function makeUrgencyPressure({
  threshold = 13,
  highOpportunity = codex.C1_RANKED_OPTIONS,
  fallback = codex.C4_RANKED_OPTIONS,
  leaderBonus = 13,
  endDrop = 14,
  behindDrop = 0,
  enemyUrgencyDrop = 0,
  leaderUrgencyBonus = 0,
  aheadHold = 0,
  maxAttacks = 120,
} = {}) {
  const highOptions = { ...codex.FAST_DEFAULTS, ...highOpportunity };
  const fallbackOptions = { ...codex.FAST_DEFAULTS, ...fallback };
  let mode = null;

  return function urgencyPressure(api) {
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
      const behind = Math.max(0, maxEnemy - c.red);
      const urgency = Math.max(0, maxEnemy - 15);
      const ahead = Math.max(0, c.red - maxEnemy);
      const dynamicThreshold = options.threshold
        - Math.max(0, c.red - 14) * endDrop
        - behind * behindDrop
        - urgency * enemyUrgencyDrop
        + ahead * aheadHold;

      let best = null;
      let bestScore = -Infinity;
      for (const item of codex.rankedMoveScores(state, options)) {
        const to = state.nodes[item.move.to];
        let score = item.score;
        if (c[to.owner] === maxEnemy) {
          const leaderGap = Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1);
          score += leaderBonus * leaderGap + leaderUrgencyBonus * urgency;
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
  const games = Number(process.argv[2]) || 160;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const candidates = [
    ['pressure', () => codex.makePressureStrategy()],
  ];
  for (const behindDrop of [0, 4, 8, 12, 18]) {
    for (const enemyUrgencyDrop of [0, 8, 14, 22, 32]) {
      for (const leaderUrgencyBonus of [0, 8, 16]) {
        for (const aheadHold of [0, 4, 8]) {
          if (!behindDrop && !enemyUrgencyDrop && !leaderUrgencyBonus && !aheadHold) continue;
          const name = `b${behindDrop}/u${enemyUrgencyDrop}/l${leaderUrgencyBonus}/a${aheadHold}`;
          candidates.push([name, () => makeUrgencyPressure({
            behindDrop,
            enemyUrgencyDrop,
            leaderUrgencyBonus,
            aheadHold,
          })]);
        }
      }
    }
  }

  const rows = [];
  for (const [name, factory] of candidates) {
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
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.name.padEnd(18)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeUrgencyPressure };
