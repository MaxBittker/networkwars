'use strict';

// Scratch-only strict experiments. This imports generated ranked option arrays
// from seed-oracle.js, but does not call seedOracleStrategy, recoverSeed, or
// api.rng(); policies use only visible board state and legal api.attack(...).

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');
const seedOracle = require('../codex-strategy/seed-oracle');

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
  const out = { red: 0, green: 0, yellow: 0, blue: 0, purple: 0 };
  for (const n of state.nodes) out[n.owner]++;
  return out;
}

function legalOptions() {
  const selected = [
    ['C1', codex.C1_RANKED_OPTIONS],
    ['C4', codex.C4_RANKED_OPTIONS],
    ['legacy', codex.LEGACY_TUNED_RANKED_OPTIONS],
    ['tuned', codex.TUNED_RANKED_OPTIONS],
  ];

  for (const [name, options] of seedOracle.TARGETED_RANKED_OPTIONS) {
    if ([
      'targetRand.7.284',
      'targetRand.99.1',
      'targetRand.314159.266',
      'targetRand.123456.217',
      'targetRand.123456.389',
    ].includes(name)) selected.push([name, options]);
  }
  for (const [name, options] of seedOracle.GENERATED_RANKED_OPTIONS) {
    if (['rankedRand.139', 'rankedRand.187', 'rankedRand.226'].includes(name)) {
      selected.push([name, options]);
    }
  }

  return selected;
}

const PLAYBOOKS = legalOptions();

function moveKey(move) {
  return `${move.from}:${move.to}`;
}

function makeCouncilStrategy({
  topK = 2,
  minVotes = 2,
  minLead = 0,
  scoreFloor = 0,
  useThreshold = true,
  leaderBonus = 0,
  endDrop = 0,
  maxAttacks = 120,
} = {}) {
  return function councilStrategy(api) {
    for (let guard = 0; guard < maxAttacks; guard++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= 24) return;

      const enemyCounts = ['green', 'yellow', 'blue', 'purple']
        .map(faction => c[faction])
        .sort((a, b) => b - a);
      const maxEnemy = enemyCounts[0];
      const secondEnemy = enemyCounts[1];
      const dynamicFloor = scoreFloor - Math.max(0, c.red - 14) * endDrop;

      const byMove = new Map();
      for (const [, options] of PLAYBOOKS) {
        const ranked = codex.rankedMoveScores(state, options);
        let added = 0;
        for (const item of ranked) {
          if (added >= topK) break;
          if (useThreshold && item.score < options.threshold) continue;

          const to = state.nodes[item.move.to];
          let score = 1 + Math.max(0, item.score - options.threshold) / 100;
          if (leaderBonus && c[to.owner] === maxEnemy) {
            const leaderGap = Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1);
            score += leaderBonus * leaderGap;
          }

          const key = moveKey(item.move);
          const current = byMove.get(key) || { move: item.move, votes: 0, score: 0 };
          current.votes++;
          current.score += score / (1 + added * 0.35);
          byMove.set(key, current);
          added++;
        }
      }

      let best = null;
      for (const cand of byMove.values()) {
        if (cand.votes < minVotes) continue;
        if (!best
          || cand.score > best.score
          || (cand.score === best.score && cand.votes > best.votes)) {
          best = cand;
        }
      }

      if (!best) return;

      const runnerUp = [...byMove.values()]
        .filter(cand => cand !== best && cand.votes >= minVotes)
        .sort((a, b) => b.score - a.score)[0];
      if (runnerUp && best.score < runnerUp.score + minLead) return;
      if (best.score < dynamicFloor) return;

      api.attack(best.move.from, best.move.to);
    }
  };
}

const candidates = {
  pressure: codex.makePressureStrategy(),
  strategy: codex.makeOpeningSelectorStrategy(),
  C1: codex.makeRankedStrategy(codex.C1_RANKED_OPTIONS),
  C4: codex.makeRankedStrategy(codex.C4_RANKED_OPTIONS),
  councilA: makeCouncilStrategy({ topK: 1, minVotes: 2, scoreFloor: 0 }),
  councilB: makeCouncilStrategy({ topK: 2, minVotes: 2, scoreFloor: 1.8 }),
  councilC: makeCouncilStrategy({ topK: 2, minVotes: 3, scoreFloor: 2.2 }),
  councilD: makeCouncilStrategy({ topK: 3, minVotes: 2, scoreFloor: 2.2, leaderBonus: 0.4, endDrop: 0.2 }),
  councilE: makeCouncilStrategy({ topK: 2, minVotes: 2, scoreFloor: 1.4, useThreshold: false }),
};

function score(policy, games, seedBase) {
  return sim.scorePolicy(policy, { games, seedBase });
}

function main() {
  const games = Number(process.argv[2]) || 300;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  const seedBases = bases.length ? bases : [1, 1001, 10001];
  const rows = [];

  for (const [name, policy] of Object.entries(candidates)) {
    let total = 0;
    const parts = [];
    for (const seedBase of seedBases) {
      const r = score(policy, games, seedBase);
      total += r.wins;
      parts.push(`${seedBase}:${r.wins}/${games}`);
    }
    rows.push({ name, total, parts });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    console.log(`${row.name.padEnd(12)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}`);
  }
}

if (require.main === module) main();

module.exports = { makeCouncilStrategy };
