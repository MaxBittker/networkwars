'use strict';

// Strict scratch experiment: choose the pressure playbook from current visible
// state rather than committing to a single opening-selected playbook.

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

function components(state, faction) {
  const seen = new Set();
  const comps = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || seen.has(n.id)) continue;
    const comp = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const nb of state.adj[id]) {
        if (state.nodes[nb].owner === faction && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function bestPressureMove(state, baseOptions, leaderBonus, endDrop) {
  const options = { ...codex.FAST_DEFAULTS, ...baseOptions };
  const c = counts(state);
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
  return best && bestScore >= dynamicThreshold ? best : null;
}

function makeStateSwitchPressure({
  redCut = 10,
  largestCut = 5,
  behindCut = 2,
  early = codex.C1_RANKED_OPTIONS,
  connected = codex.C4_RANKED_OPTIONS,
  behind = codex.LEGACY_TUNED_RANKED_OPTIONS,
  defaultBook = codex.C4_RANKED_OPTIONS,
  leaderBonus = 13,
  endDrop = 14,
  maxAttacks = 120,
} = {}) {
  return function stateSwitchPressure(api) {
    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= 24) return;
      const redComps = components(state, 'red');
      const largestRed = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
      const maxEnemy = Math.max(...BOTS.map(f => c[f]));
      const gap = maxEnemy - c.red;

      let book = defaultBook;
      if (gap >= behindCut) book = behind;
      else if (c.red <= redCut) book = early;
      else if (largestRed >= largestCut) book = connected;

      const move = bestPressureMove(state, book, leaderBonus, endDrop);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function main() {
  const games = Number(process.argv[2]) || 150;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const books = {
    C1: codex.C1_RANKED_OPTIONS,
    C4: codex.C4_RANKED_OPTIONS,
    legacy: codex.LEGACY_TUNED_RANKED_OPTIONS,
  };
  const candidates = [
    ['pressure', () => codex.makePressureStrategy()],
  ];
  for (const redCut of [8, 10, 12, 14]) {
    for (const largestCut of [4, 6, 8]) {
      for (const behindCut of [1, 2, 3, 99]) {
        for (const behindName of ['C1', 'C4', 'legacy']) {
          const name = `r${redCut}/l${largestCut}/b${behindCut}/${behindName}`;
          candidates.push([name, () => makeStateSwitchPressure({
            redCut,
            largestCut,
            behindCut,
            behind: books[behindName],
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

module.exports = { makeStateSwitchPressure };
