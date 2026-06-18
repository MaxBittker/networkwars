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

function componentLabels(state) {
  const labels = new Map();
  const sizes = [];
  let largestId = -1;
  for (const n of state.nodes) {
    if (n.owner !== 'red' || labels.has(n.id)) continue;
    const id = sizes.length;
    const stack = [n.id];
    labels.set(n.id, id);
    let size = 0;
    while (stack.length) {
      const cur = stack.pop();
      size++;
      for (const nb of state.adj[cur]) {
        if (state.nodes[nb].owner === 'red' && !labels.has(nb)) {
          labels.set(nb, id);
          stack.push(nb);
        }
      }
    }
    sizes.push(size);
    if (largestId === -1 || size > sizes[largestId]) largestId = id;
  }
  return { labels, sizes, largestId };
}

function makeSimpleRaceStrategy({
  threshold = 96,
  pWeight = 120,
  growWeight = 34,
  mergeWeight = 26,
  leaderWeight = 8,
  marginWeight = 5,
  weakWeight = 12,
  redAdjWeight = 8,
  exposureWeight = 12,
  endDrop = 9,
  maxAttacks = 120,
} = {}) {
  return function simpleRace(api) {
    for (let guard = 0; guard < maxAttacks; guard++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= 24) return;

      const labels = componentLabels(state);
      const enemyCounts = BOTS.map(f => c[f]).sort((a, b) => b - a);
      const maxEnemy = enemyCounts[0];
      const secondEnemy = enemyCounts[1];
      const dynamicThreshold = threshold - Math.max(0, c.red - 14) * endDrop;

      let best = null;
      let bestScore = -Infinity;
      for (const move of legalMoves(state)) {
        const from = state.nodes[move.from];
        const to = state.nodes[move.to];
        const p = codex.captureProbability(from.strength, to.strength);
        const expectedStrength = codex.expectedCapturedStrength(from.strength, to.strength);
        const touching = new Set([labels.labels.get(from.id)]);
        let redAdj = 0;
        let exposure = 0;

        for (const nbId of state.adj[to.id]) {
          const nb = state.nodes[nbId];
          if (nb.owner === 'red') {
            redAdj++;
            touching.add(labels.labels.get(nb.id));
          } else if (nb.id !== from.id && nb.strength > expectedStrength) {
            exposure += codex.captureProbability(nb.strength, Math.max(1, expectedStrength));
          }
        }

        const sourceComp = labels.labels.get(from.id);
        const sourceSize = sourceComp === undefined ? 0 : labels.sizes[sourceComp];
        const touchesLargest = touching.has(labels.largestId);
        const mergeCount = Math.max(0, [...touching].filter(x => x !== undefined).length - 1);
        const grow = touchesLargest ? 1 : Math.max(0, sourceSize - 1) * 0.15;
        const leaderGap = c[to.owner] === maxEnemy
          ? Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1)
          : 0;

        const score = p * pWeight
          + grow * growWeight
          + mergeCount * mergeWeight
          + leaderGap * leaderWeight
          + (from.strength - to.strength) * marginWeight
          + weakWeight / Math.max(1, to.strength)
          + redAdj * redAdjWeight
          - exposure * exposureWeight;

        if (score > bestScore) {
          best = move;
          bestScore = score;
        }
      }

      if (!best || bestScore < dynamicThreshold) return;
      api.attack(best.from, best.to);
    }
  };
}

const games = Number(process.argv[2]) || 160;
const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
if (!seedBases.length) seedBases.push(1, 1001, 10001);

function score(name, policy) {
  let total = 0;
  const parts = [];
  for (const seedBase of seedBases) {
    const r = sim.scorePolicy(policy, { games, seedBase });
    total += r.wins;
    parts.push(`${seedBase}:${r.wins}/${games}`);
  }
  return { name, total, parts };
}

function main() {
  const rows = [
    score('pressure', codex.makePressureStrategy()),
    score('simpleDefault', makeSimpleRaceStrategy()),
  ];
  for (const threshold of [80, 90, 100, 110, 125]) {
    for (const pWeight of [90, 110, 130, 155]) {
      for (const growWeight of [20, 35, 50]) {
        for (const leaderWeight of [0, 8, 14, 22]) {
          for (const endDrop of [4, 9, 14, 20]) {
            const name = `t${threshold}/p${pWeight}/g${growWeight}/l${leaderWeight}/e${endDrop}`;
            rows.push(score(name, makeSimpleRaceStrategy({
              threshold,
              pWeight,
              growWeight,
              leaderWeight,
              endDrop,
            })));
          }
        }
      }
    }
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.name.padEnd(28)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}`);
  }
}

if (require.main === module) main();

module.exports = { makeSimpleRaceStrategy };
