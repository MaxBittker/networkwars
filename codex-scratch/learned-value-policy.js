'use strict';

// Strict scratch experiment: learn a small linear public-state value function
// offline, then use it as a deterministic evaluator over a small candidate set.
// Runtime policies use only visible board features and legal api.attack(...)
// calls. No api.rng(), seed recovery, board lookup tables, live-node mutation,
// or benchmark-order state.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';
const WIN_NODES = 24;

const FEATURE_NAMES = [
  'bias',
  'red',
  'gap',
  'largest',
  'splits',
  'redStrength',
  'largestStrength',
  'borderStrength',
  'weakBorder',
  'risk',
  'threatened',
  'beatable',
  'legal',
  'goodMoves',
  'weakTargets',
  'maxEnemy',
  'enemyStrength',
];

// Fallback hand-shaped coefficients. The CLI can fit better coefficients on
// explicit training windows; these defaults keep the runtime factory usable.
const DEFAULT_COEFFICIENTS = [
  -0.42, 2.8, -2.1, 1.8, -0.9, 0.55, 0.7, 0.35, -0.9,
  -1.5, -0.7, -0.45, 0.18, 0.8, 0.32, -1.5, -0.38,
];

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

function featureVector(state) {
  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const largestSet = new Set(redComps.find(comp => comp.length === largest) || []);
  const enemyCounts = BOTS.map(f => c[f]).sort((a, b) => b - a);
  const maxEnemy = enemyCounts[0];
  let redStrength = 0;
  let largestStrength = 0;
  let borderStrength = 0;
  let weakBorder = 0;
  let risk = 0;
  let threatened = 0;
  let beatable = 0;
  let goodMoves = 0;
  let weakTargets = 0;
  let enemyStrength = 0;

  for (const n of state.nodes) {
    if (n.owner === HUMAN) {
      redStrength += n.strength;
      if (largestSet.has(n.id)) largestStrength += n.strength;
      const border = state.adj[n.id].some(nb => state.nodes[nb].owner !== HUMAN);
      if (border) {
        borderStrength += n.strength;
        if (n.strength <= 2) weakBorder++;
      }
      if (n.strength > 1) {
        for (const nbId of state.adj[n.id]) {
          const nb = state.nodes[nbId];
          if (nb.owner === HUMAN) continue;
          const p = codex.captureProbability(n.strength, nb.strength);
          if (p >= 0.35) goodMoves += p;
          if (nb.strength <= 2) weakTargets += p;
        }
      }
    } else {
      enemyStrength += n.strength;
      if (n.strength <= 1) continue;
      for (const nbId of state.adj[n.id]) {
        const nb = state.nodes[nbId];
        if (nb.owner !== HUMAN || n.strength <= nb.strength) continue;
        const p = codex.captureProbability(n.strength, nb.strength);
        risk += p;
        beatable++;
        if (p > 0.45) threatened++;
      }
    }
  }

  return [
    1,
    c.red / 30,
    (maxEnemy - c.red) / 30,
    largest / 30,
    Math.max(0, redComps.length - 1) / 6,
    redStrength / 120,
    largestStrength / 120,
    borderStrength / 120,
    weakBorder / 12,
    risk / 10,
    threatened / 12,
    beatable / 24,
    legalMoves(state).length / 40,
    goodMoves / 20,
    weakTargets / 20,
    maxEnemy / 30,
    enemyStrength / 160,
  ];
}

function valueState(state, coefficients = DEFAULT_COEFFICIENTS) {
  const c = counts(state);
  if (c.red >= WIN_NODES) return 1000;
  if (c.red === 0) return -1000;
  const x = featureVector(state);
  let value = 0;
  for (let i = 0; i < x.length; i++) value += x[i] * coefficients[i];
  return value;
}

function valueAfterReinforcement(state, coefficients) {
  const next = cloneState(state);
  reinforce(next, HUMAN);
  return valueState(next, coefficients);
}

function candidateMoves(state, { rankedLimit = 6, rawLimit = 4, minP = 0.25 } = {}) {
  const out = new Map();
  const rankedScores = new Map();
  for (const item of codex.rankedMoveScores(state, { ...codex.FAST_DEFAULTS, ...codex.DELAYED_MERGE_RANKED_OPTIONS })) {
    const key = `${item.move.from}:${item.move.to}`;
    rankedScores.set(key, item.score);
    if (out.size < rankedLimit) out.set(key, item.move);
  }

  const raw = [];
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    if (p < minP) continue;
    let redAdj = 0;
    for (const nb of state.adj[to.id]) if (state.nodes[nb].owner === HUMAN) redAdj++;
    raw.push({
      move,
      score: p * 100
        + redAdj * 18
        + Math.max(0, from.strength - to.strength) * 6
        + (to.strength <= 2 ? 12 : 0)
        + (c[to.owner] === maxEnemy ? 12 : 0),
    });
  }
  raw.sort((a, b) => b.score - a.score);
  for (const item of raw.slice(0, rawLimit)) out.set(`${item.move.from}:${item.move.to}`, item.move);

  return [...out.values()].map(move => ({
    move,
    rankedScore: rankedScores.get(`${move.from}:${move.to}`) || 0,
  }));
}

function selectLearnedValueMove(state, {
  coefficients = DEFAULT_COEFFICIENTS,
  minGain = 0.02,
  rankWeight = 0.0005,
  candidateLimit = 8,
  ...candidateOptions
} = {}) {
  const baseValue = valueAfterReinforcement(state, coefficients);
  let best = null;
  let bestScore = -Infinity;
  for (const item of candidateMoves(state, candidateOptions).slice(0, candidateLimit)) {
    const from = state.nodes[item.move.from];
    const to = state.nodes[item.move.to];
    let expected = 0;
    for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
      expected += outcome.prob * valueAfterReinforcement(applyOutcome(state, item.move, outcome), coefficients);
    }
    const score = expected - baseValue + item.rankedScore * rankWeight;
    if (score > bestScore) {
      best = item.move;
      bestScore = score;
    }
  }
  return best && bestScore >= minGain ? best : null;
}

function makeLearnedValueStrategy({
  coefficients = DEFAULT_COEFFICIENTS,
  modalOpening = true,
  maxOpeningAttacks = 2,
  maxAttacks = 90,
  moveOptions = {},
  fallbackSafety = true,
} = {}) {
  let openingHandled = false;

  return function learnedValueStrategy(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (modalOpening && !openingHandled && isOpening(initial)) {
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
      const c = counts(state);
      if (c.red >= WIN_NODES) return;
      let move = selectLearnedValueMove(state, { coefficients, ...moveOptions });
      if (!move && fallbackSafety) {
        const maxEnemy = Math.max(...BOTS.map(f => c[f]));
        move = codex.selectSafetyRankedMove(state, {
          rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
          topK: 6,
          countWeight: 14,
          minScore: 210,
          splitWeight: 25,
          threatenedWeight: maxEnemy - c.red >= 2 ? 36 : 16,
        });
      }
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function makeTrace(seed, policyFactory = () => codex.codexModalOpeningGap, { minTurn = 1, maxTurn = 300 } = {}) {
  const policy = policyFactory();
  const rng = G.makeRng(seed >>> 0);
  const board = G.buildBoard(rng);
  const state = { ...board, rng, policyRng: G.makeRng((seed ^ 0x9e3779b9) >>> 0) };
  const samples = [];
  let turn = 0;
  while (!G.checkWinner(state) && turn < 300) {
    turn++;
    if (turn >= minTurn && turn <= maxTurn) samples.push(featureVector(state));
    try { policy(sim.turnApi(state, HUMAN)); } catch (_) {}
    if (!G.checkWinner(state)) G.reinforce(state, HUMAN);
    if (!G.checkWinner(state)) {
      for (const bot of G.BOTS) {
        G.runBotTurn(state, bot, []);
        if (G.checkWinner(state)) break;
      }
    }
  }
  const y = G.checkWinner(state) === HUMAN ? 1 : -1;
  return samples.map(x => ({ x, y }));
}

function solveLinearSystem(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) continue;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const div = m[col][col];
    for (let k = col; k <= n; k++) m[col][k] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      if (!factor) continue;
      for (let k = col; k <= n; k++) m[row][k] -= factor * m[col][k];
    }
  }
  return m.map(row => row[n]);
}

function fitRidge(samples, lambda = 1.0) {
  const n = FEATURE_NAMES.length;
  const xtx = Array.from({ length: n }, () => Array(n).fill(0));
  const xty = Array(n).fill(0);
  for (const { x, y } of samples) {
    for (let i = 0; i < n; i++) {
      xty[i] += x[i] * y;
      for (let j = 0; j < n; j++) xtx[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < n; i++) xtx[i][i] += lambda;
  return solveLinearSystem(xtx, xty);
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

function trainCoefficients({ games, bases, lambda, minTurn = 1, maxTurn = 300 }) {
  const samples = [];
  for (const seedBase of bases) {
    for (let i = 0; i < games; i++) samples.push(...makeTrace(seedBase + i, () => codex.codexModalOpeningGap, { minTurn, maxTurn }));
  }
  return { coefficients: fitRidge(samples, lambda), samples: samples.length };
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
  const games = Number(argValue('games')) || 120;
  const trainBases = parseList(argValue('train'), [1, 1001, 2001, 10001]);
  const validBases = parseList(argValue('valid'), [50001, 900001, 910001, 920001]);
  const lambda = Number(argValue('lambda')) || 5;
  const minTurn = Number(argValue('minTurn')) || 1;
  const maxTurn = Number(argValue('maxTurn')) || 300;
  const trained = trainCoefficients({ games, bases: trainBases, lambda, minTurn, maxTurn });
  console.log(`trained ${trained.samples} samples, lambda=${lambda}, turns=${minTurn}..${maxTurn}`);
  console.log(`coefficients=[${trained.coefficients.map(v => Number(v).toFixed(6)).join(',')}]`);

  const rows = [
    ['modal', () => codex.codexModalOpeningGap],
    ['learned', () => makeLearnedValueStrategy({ coefficients: trained.coefficients })],
    ['learnedTight', () => makeLearnedValueStrategy({
      coefficients: trained.coefficients,
      moveOptions: { minGain: 0.08, rankedLimit: 5, rawLimit: 3, candidateLimit: 6 },
    })],
    ['learnedFallbackOnly', () => makeLearnedValueStrategy({
      coefficients: trained.coefficients,
      moveOptions: { minGain: 0.18, rankedLimit: 4, rawLimit: 2, candidateLimit: 5 },
    })],
  ].map(([name, factory]) => scoreCandidate(name, factory, Math.max(40, Math.floor(games / 2)), validBases));

  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows) {
    console.log(`${row.name.padEnd(20)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  FEATURE_NAMES,
  DEFAULT_COEFFICIENTS,
  featureVector,
  fitRidge,
  trainCoefficients,
  makeLearnedValueStrategy,
  selectLearnedValueMove,
};
