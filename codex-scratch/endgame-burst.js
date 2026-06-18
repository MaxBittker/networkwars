'use strict';

// Strict scratch experiment: keep the current defensive opening and SafetyK2
// midgame, but when RED is close to the 24-node win condition, use a simple
// capture-focused finisher. No api.rng(), seed recovery, node mutation, or
// cross-game benchmark state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';
const WIN_NODES = 24;

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
  const out = [];
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
    out.push(comp);
  }
  return out;
}

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function legalMoves(state) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      if (state.nodes[to].owner !== HUMAN) moves.push({ from: n.id, to });
    }
  }
  return moves;
}

function redRiskAtTarget(state, targetId, expectedStrength) {
  let risk = 0;
  for (const nbId of state.adj[targetId]) {
    const nb = state.nodes[nbId];
    if (nb.owner !== HUMAN && nb.strength > expectedStrength) {
      risk += codex.captureProbability(nb.strength, expectedStrength);
    }
  }
  return risk;
}

function selectBurstMove(state, {
  minP = 0.42,
  leaderBonus = 18,
  weakBonus = 8,
  mergeBonus = 20,
  exposurePenalty = 10,
  marginWeight = 3,
} = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const redComps = components(state, HUMAN);
  const compByNode = new Map();
  redComps.forEach((comp, index) => {
    for (const id of comp) compByNode.set(id, index);
  });

  let best = null;
  let bestScore = -Infinity;
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    if (p < minP) continue;

    const expectedStrength = codex.expectedCapturedStrength(from.strength, to.strength);
    const touching = new Set([compByNode.get(from.id)]);
    for (const nbId of state.adj[to.id]) {
      if (state.nodes[nbId].owner === HUMAN) touching.add(compByNode.get(nbId));
    }

    let score = 0;
    score += p * 120;
    score += (from.strength - to.strength) * marginWeight;
    score += (3 - Math.min(3, to.strength)) * weakBonus;
    score += Math.max(0, touching.size - 1) * mergeBonus;
    if (c[to.owner] === maxEnemy) score += leaderBonus;
    if (c.red >= WIN_NODES - 1) score += 100000;
    score -= redRiskAtTarget(state, to.id, Math.max(1, expectedStrength)) * exposurePenalty;

    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }

  return best;
}

function makeEndgameBurst({
  finishAt = 20,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  safetyOptions = {},
  burstOptions = {},
} = {}) {
  let openingHandled = false;

  return function endgameBurst(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = codex.selectOpeningDefenseMove(state, {
          rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
          minP: 0.55,
          minScore: 60,
          riskWeight: 55,
        });
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= WIN_NODES) return;

      let move = null;
      if (c.red >= finishAt) move = selectBurstMove(state, burstOptions);
      if (!move) {
        move = codex.selectSafetyRankedMove(state, {
          rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
          minScore: 210,
          splitWeight: 25,
          ...safetyOptions,
        });
      }
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

const candidateFactories = {
  safetyK2: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }),
  threat36: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, threatenedWeight: 36 }),
  burst20: () => makeEndgameBurst({ finishAt: 20, burstOptions: { minP: 0.42 } }),
  burst21: () => makeEndgameBurst({ finishAt: 21, burstOptions: { minP: 0.42 } }),
  burst22: () => makeEndgameBurst({ finishAt: 22, burstOptions: { minP: 0.38 } }),
  burstT20: () => makeEndgameBurst({
    finishAt: 20,
    safetyOptions: { threatenedWeight: 36 },
    burstOptions: { minP: 0.42 },
  }),
  burstCautious: () => makeEndgameBurst({ finishAt: 21, burstOptions: { minP: 0.55, exposurePenalty: 18 } }),
};

function main() {
  const games = Number(process.argv[2]) || 120;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 10001);

  const rows = [];
  for (const [name, factory] of Object.entries(candidateFactories)) {
    let total = 0;
    let totalMs = 0;
    const parts = [];
    for (const seedBase of bases) {
      const result = sim.scorePolicy(factory(), { games, seedBase });
      total += result.wins;
      totalMs += result.totalMs;
      parts.push(`${seedBase}:${result.wins}/${games}`);
    }
    rows.push({ name, total, parts, msPerGame: totalMs / (games * bases.length) });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    console.log(`${row.name.padEnd(14)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeEndgameBurst,
  selectBurstMove,
};
