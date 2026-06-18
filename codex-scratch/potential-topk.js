'use strict';

// Strict scratch experiment: rank a small candidate set, then choose the move
// with the best exact expected position value after RED reinforcement. This is
// a bounded version of the older full expected-value selector: no api.rng(),
// seed recovery, board lookup tables, live-node mutation, or game-index state.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
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

function reinforce(state, faction) {
  const comps = components(state, faction);
  if (!comps.length) return;
  let largest = comps[0];
  for (const comp of comps) if (comp.length > largest.length) largest = comp;
  const border = largest
    .filter(id => state.adj[id].some(nb => state.nodes[nb].owner !== faction))
    .sort((a, b) => a - b);
  if (!border.length) return;
  for (let i = 0; i < largest.length; i++) state.nodes[border[i % border.length]].strength++;
}

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function applyOutcome(state, move, outcome) {
  const next = cloneState(state);
  const from = next.nodes[move.from];
  const to = next.nodes[move.to];
  from.strength = outcome.fromStrength;
  if (outcome.captured) to.owner = from.owner;
  to.strength = outcome.toStrength;
  return next;
}

function valueAfterReinforcement(state, weights) {
  const next = cloneState(state);
  reinforce(next, HUMAN);
  return codex.evaluatePosition(next, weights);
}

function expectedPotentialGain(state, move, weights, baseValue) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  let expected = 0;
  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    expected += outcome.prob * valueAfterReinforcement(applyOutcome(state, move, outcome), weights);
  }
  return expected - baseValue;
}

function selectPotentialMove(state, {
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  topK = 6,
  threshold = 12,
  rankWeight = 0,
  weights = codex.DEFAULT_WEIGHTS,
} = {}) {
  const ranked = codex.rankedMoveScores(state, rankedOptions).slice(0, topK);
  if (!ranked.length) return null;

  const baseValue = valueAfterReinforcement(state, weights);
  let bestMove = null;
  let bestScore = -Infinity;

  for (const item of ranked) {
    const score = expectedPotentialGain(state, item.move, weights, baseValue)
      + item.score * rankWeight;
    if (score > bestScore) {
      bestScore = score;
      bestMove = item.move;
    }
  }

  return bestScore >= threshold ? bestMove : null;
}

function makePotentialTopKStrategy({
  maxOpeningAttacks = 2,
  openingRiskWeight = 75,
  maxAttacks = 120,
  ...options
} = {}) {
  let openingHandled = false;

  return function potentialTopKStrategy(api) {
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
          riskWeight: openingRiskWeight,
        });
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = selectPotentialMove(state, options);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map(Number).filter(Number.isFinite);
}

function argValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function candidates() {
  const weightSets = {
    default: codex.DEFAULT_WEIGHTS,
    safe: { ...codex.DEFAULT_WEIGHTS, botThreatPenalty: 130, weakBorderPenalty: 18 },
    growth: { ...codex.DEFAULT_WEIGHTS, redCount: 175, largestComponent: 115, enemyCountPenalty: 20 },
    compact: { ...codex.DEFAULT_WEIGHTS, largestComponent: 130, splitPenalty: 65, largestStrength: 8 },
  };

  const out = [];
  for (const [weightName, weights] of Object.entries(weightSets)) {
    for (const topK of [3, 4, 6, 8]) {
      for (const threshold of [0, 8, 16, 32]) {
        out.push([
          `${weightName}-k${topK}-t${threshold}`,
          () => makePotentialTopKStrategy({ weights, topK, threshold }),
        ]);
      }
    }
  }
  for (const rankWeight of [0.02, 0.04, 0.08]) {
    out.push([
      `growth-k6-t16-r${rankWeight}`,
      () => makePotentialTopKStrategy({
        weights: weightSets.growth,
        topK: 6,
        threshold: 16,
        rankWeight,
      }),
    ]);
  }
  return out;
}

function scoreCandidate(name, factory, games, bases) {
  let total = 0;
  let totalMs = 0;
  const parts = [];
  for (const seedBase of bases) {
    const result = sim.scorePolicy(factory(), { games, seedBase });
    total += result.wins;
    totalMs += result.totalMs;
    parts.push(`${seedBase}:${result.wins}/${games}`);
  }
  return { name, total, totalGames: games * bases.length, parts, msPerGame: totalMs / (games * bases.length) };
}

function main() {
  const games = Number(argValue('games')) || 80;
  const bases = parseList(argValue('bases'), [1, 1001, 2001, 10001, 50001]);
  const rows = candidates().map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.name.padEnd(24)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makePotentialTopKStrategy,
  selectPotentialMove,
};
