'use strict';

// Strict scratch experiment: pressure scoring plus a cheap post-reinforcement
// border-safety term. Uses visible state only and legal api.attack(...) calls.

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

function cloneState(state) {
  return {
    nodes: state.nodes.map(n => ({
      id: n.id,
      x: n.x,
      y: n.y,
      owner: n.owner,
      strength: n.strength,
    })),
    adj: state.adj,
  };
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

function reinforce(state, faction) {
  const comps = components(state, faction);
  if (!comps.length) return;
  let largest = comps[0];
  for (const comp of comps) if (comp.length > largest.length) largest = comp;
  const border = largest
    .filter(id => state.adj[id].some(nb => state.nodes[nb].owner !== faction))
    .sort((a, b) => a - b);
  if (!border.length) return;
  for (let i = 0; i < largest.length; i++) {
    state.nodes[border[i % border.length]].strength++;
  }
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

function applyExpectedCapture(state, move) {
  const next = cloneState(state);
  const from = next.nodes[move.from];
  const to = next.nodes[move.to];
  to.owner = 'red';
  to.strength = Math.max(1, Math.round(codex.expectedCapturedStrength(from.strength, to.strength)));
  from.strength = 1;
  return next;
}

function borderSafety(state) {
  const redComps = components(state, 'red');
  const largest = redComps.reduce((best, comp) => comp.length > best.length ? comp : best, []);
  const largestSet = new Set(largest);
  let score = largest.length * 6 - Math.max(0, redComps.length - 1) * 12;

  for (const n of state.nodes) {
    if (n.owner !== 'red') continue;
    const enemyNeighbors = state.adj[n.id].map(id => state.nodes[id]).filter(nb => nb.owner !== 'red');
    if (!enemyNeighbors.length) continue;
    const onLargest = largestSet.has(n.id);
    score += Math.min(8, n.strength) * (onLargest ? 2.4 : 1.2);
    for (const enemy of enemyNeighbors) {
      const threat = codex.captureProbability(enemy.strength, n.strength);
      score -= threat * (onLargest ? 22 : 10);
      if (enemy.strength > n.strength) score -= (enemy.strength - n.strength) * (onLargest ? 2.5 : 1);
    }
  }
  return score;
}

function makeFortressPressure({
  threshold = 13,
  highOpportunity = codex.C1_RANKED_OPTIONS,
  fallback = codex.C4_RANKED_OPTIONS,
  leaderBonus = 13,
  endDrop = 14,
  safetyWeight = 0,
  safetyTopK = 6,
  minCaptureProb = 0.25,
  maxAttacks = 120,
} = {}) {
  const highOptions = { ...codex.FAST_DEFAULTS, ...highOpportunity };
  const fallbackOptions = { ...codex.FAST_DEFAULTS, ...fallback };
  let mode = null;

  return function fortressPressure(api) {
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
      const baseSafety = safetyWeight ? borderSafety(state) : 0;

      let best = null;
      let bestScore = -Infinity;
      const ranked = codex.rankedMoveScores(state, options);
      for (let idx = 0; idx < ranked.length; idx++) {
        const item = ranked[idx];
        const from = state.nodes[item.move.from];
        const to = state.nodes[item.move.to];
        const pCap = codex.captureProbability(from.strength, to.strength);
        if (pCap < minCaptureProb) continue;

        let score = item.score;
        if (c[to.owner] === maxEnemy) {
          const leaderGap = Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1);
          score += leaderBonus * leaderGap;
        }

        if (safetyWeight && idx < safetyTopK) {
          const after = applyExpectedCapture(state, item.move);
          reinforce(after, 'red');
          score += safetyWeight * (borderSafety(after) - baseSafety) * pCap;
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
  for (const safetyWeight of [0.4, 0.8, 1.4, 2.2, 3.5]) {
    for (const safetyTopK of [3, 6, 10]) {
      for (const minCaptureProb of [0.15, 0.25, 0.35]) {
        const name = `w${safetyWeight}/k${safetyTopK}/p${minCaptureProb}`;
        candidates.push([name, () => makeFortressPressure({
          safetyWeight,
          safetyTopK,
          minCaptureProb,
        })]);
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
    console.log(`${row.name.padEnd(16)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeFortressPressure };
