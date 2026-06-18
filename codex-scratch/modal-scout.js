'use strict';

// Strict scratch experiment: use the validated modal opening and safety
// midgame as the baseline, then allow a small one-round modal simulation to
// override the current safety move only when it sees a clearer next-round
// swing. No api.rng(), seed recovery, board lookup tables, live-node mutation,
// or benchmark-order/game-index state.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const HUMAN = 'red';
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
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

function isOpening(state) {
  const c = G.counts(state);
  return FACTIONS.every(faction => c[faction] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function applyOutcomeInPlace(state, move, outcome) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  from.strength = outcome.fromStrength;
  if (outcome.captured) to.owner = from.owner;
  to.strength = outcome.toStrength;
}

function applyOutcome(state, move, outcome) {
  const next = cloneState(state);
  applyOutcomeInPlace(next, move, outcome);
  return next;
}

function modalOutcome(attackerStrength, defenderStrength) {
  let best = null;
  for (const outcome of codex.battleOutcomes(attackerStrength, defenderStrength)) {
    if (!best
      || outcome.prob > best.prob
      || (outcome.prob === best.prob && outcome.captured && !best.captured)
      || (outcome.prob === best.prob && outcome.captured === best.captured && outcome.toStrength > best.toStrength)) {
      best = outcome;
    }
  }
  return best;
}

function runModalBotTurn(state, faction) {
  if (G.counts(state)[faction] === 0) return;
  let guard = 0;
  while (guard++ < 120 && !G.checkWinner(state)) {
    const move = G.bestBotMove(state, faction);
    if (!move) break;
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    applyOutcomeInPlace(state, move, modalOutcome(from.strength, to.strength));
  }
  if (!G.checkWinner(state)) G.reinforce(state, faction);
}

function riskStats(state) {
  let risk = 0;
  let count = 0;
  const threatened = new Set();

  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      risk += p;
      count++;
      if (p > 0.45) threatened.add(to);
    }
  }

  return { risk, count, threatened: threatened.size };
}

function modalRoundStats(state) {
  const s = cloneState(state);
  G.reinforce(s, HUMAN);
  for (const bot of BOTS) {
    runModalBotTurn(s, bot);
    if (G.checkWinner(s)) break;
  }

  const c = G.counts(s);
  const redComps = G.componentsOf(s, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redStrength = s.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const risk = riskStats(s);

  return {
    red: c.red,
    maxEnemy,
    largest,
    redStrength,
    splits: Math.max(0, redComps.length - 1),
    risk: risk.risk,
    count: risk.count,
    threatened: risk.threatened,
  };
}

function expectedModalSwing(state, move) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const current = modalRoundStats(state);
  const out = {
    redGain: 0,
    largestGain: 0,
    strengthGain: 0,
    splitDrop: 0,
    maxEnemyDrop: 0,
    riskDrop: 0,
    countDrop: 0,
    threatenedDrop: 0,
  };

  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const stats = modalRoundStats(applyOutcome(state, move, outcome));
    out.redGain += outcome.prob * (stats.red - current.red);
    out.largestGain += outcome.prob * (stats.largest - current.largest);
    out.strengthGain += outcome.prob * (stats.redStrength - current.redStrength);
    out.splitDrop += outcome.prob * (current.splits - stats.splits);
    out.maxEnemyDrop += outcome.prob * (current.maxEnemy - stats.maxEnemy);
    out.riskDrop += outcome.prob * (current.risk - stats.risk);
    out.countDrop += outcome.prob * (current.count - stats.count);
    out.threatenedDrop += outcome.prob * (current.threatened - stats.threatened);
  }

  return out;
}

function moveKey(move) {
  return `${move.from}:${move.to}`;
}

function baselineSafetyMove(state) {
  const c = G.counts(state);
  const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
  return codex.selectSafetyRankedMove(state, {
    topK: 6,
    countWeight: 14,
    minScore: 210,
    splitWeight: 25,
    threatenedWeight: maxEnemy - c.red >= 2 ? 36 : 16,
  });
}

function scoutCandidates(state, baseline, topK) {
  const seen = new Set();
  const out = [];
  function add(move) {
    if (!move) return;
    const key = moveKey(move);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(move);
  }

  add(baseline);
  for (const item of codex.rankedMoveScores(state, {
    ...codex.FAST_DEFAULTS,
    ...codex.DELAYED_MERGE_RANKED_OPTIONS,
  }).slice(0, topK)) {
    add(item.move);
  }
  return out;
}

function scoreSwing(swing, weights) {
  return swing.redGain * weights.redGain
    + swing.largestGain * weights.largest
    + swing.strengthGain * weights.strength
    + swing.splitDrop * weights.split
    + swing.maxEnemyDrop * weights.enemy
    + swing.riskDrop * weights.risk
    + swing.countDrop * weights.count
    + swing.threatenedDrop * weights.threatened;
}

function selectModalScoutMove(state, {
  topK = 3,
  minEdge = 18,
  minScoreWithoutBaseline = 45,
  weights = {
    redGain: 70,
    largest: 28,
    strength: 1,
    split: 20,
    enemy: 16,
    risk: 18,
    count: 6,
    threatened: 12,
  },
} = {}) {
  const baseline = baselineSafetyMove(state);
  const candidates = scoutCandidates(state, baseline, topK);
  if (!candidates.length) return null;

  let best = null;
  let bestScore = -Infinity;
  let baselineScore = baseline ? -Infinity : null;
  const baselineKey = baseline && moveKey(baseline);

  for (const move of candidates) {
    const score = scoreSwing(expectedModalSwing(state, move), weights);
    if (baselineKey && moveKey(move) === baselineKey) baselineScore = score;
    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }

  if (!baseline) return bestScore >= minScoreWithoutBaseline ? best : null;
  if (moveKey(best) === baselineKey) return baseline;
  return bestScore >= baselineScore + minEdge ? best : baseline;
}

function makeModalScoutStrategy({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  scoutOptions = {},
  scoutWhen = () => true,
} = {}) {
  let openingHandled = false;

  return function modalScoutStrategy(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = codex.selectModalOpeningMove(state);
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      const c = G.counts(state);
      if (c.red >= WIN_NODES) return;
      const move = scoutWhen(state, c)
        ? selectModalScoutMove(state, scoutOptions)
        : baselineSafetyMove(state);
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
  return [
    ['modal', () => codex.codexModalOpeningGap],
    ['scout2-edge18', () => makeModalScoutStrategy({ scoutOptions: { topK: 2, minEdge: 18 } })],
    ['scout2-edge35', () => makeModalScoutStrategy({ scoutOptions: { topK: 2, minEdge: 35 } })],
    ['scout3-edge25', () => makeModalScoutStrategy({ scoutOptions: { topK: 3, minEdge: 25 } })],
    ['behind2', () => makeModalScoutStrategy({
      scoutOptions: { topK: 2, minEdge: 18 },
      scoutWhen: (state, c) => Math.max(...BOTS.map(f => c[f])) - c.red >= 2,
    })],
    ['smallRed', () => makeModalScoutStrategy({
      scoutOptions: { topK: 2, minEdge: 18 },
      scoutWhen: (state, c) => c.red <= 10,
    })],
    ['riskOnly', () => makeModalScoutStrategy({
      scoutOptions: { topK: 2, minEdge: 18 },
      scoutWhen: state => riskStats(state).risk >= 1.2,
    })],
  ];
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
  const games = Number(argValue('games')) || 60;
  const bases = parseList(argValue('bases'), [1, 1001, 2001]);
  const rows = candidates().map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows) {
    console.log(`${row.name.padEnd(16)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeModalScoutStrategy,
  selectModalScoutMove,
  expectedModalSwing,
};
