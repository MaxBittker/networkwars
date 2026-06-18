'use strict';

// Strict scratch experiment: keep the modal opening and exact-safety midgame,
// but in visibly collapsed early states switch to a simple growth-biased move
// selector. No api.rng(), seed recovery, board lookup, live-node mutation, or
// benchmark-order state.

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

function selectGrowthMove(state, {
  minP = 0.24,
  minScore = 65,
  rankedWeight = 0.08,
  captureWeight = 150,
  weakWeight = 18,
  mergeWeight = 28,
  leaderWeight = 16,
  sourcePenalty = 8,
  marginWeight = 5,
} = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const comps = components(state, HUMAN);
  const compByNode = new Map();
  comps.forEach((comp, index) => {
    for (const id of comp) compByNode.set(id, index);
  });
  const ranked = new Map();
  for (const item of codex.rankedMoveScores(state, { ...codex.FAST_DEFAULTS, ...codex.DELAYED_MERGE_RANKED_OPTIONS })) {
    ranked.set(`${item.move.from}:${item.move.to}`, item.score);
  }

  let best = null;
  let bestScore = -Infinity;
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    if (p < minP) continue;

    const touching = new Set([compByNode.get(from.id)]);
    for (const nb of state.adj[to.id]) {
      if (state.nodes[nb].owner === HUMAN) touching.add(compByNode.get(nb));
    }

    const score =
      p * captureWeight
      + (to.strength <= 2 ? weakWeight * (3 - to.strength) : 0)
      + Math.max(0, touching.size - 1) * mergeWeight
      + (c[to.owner] === maxEnemy ? leaderWeight : 0)
      + Math.max(0, from.strength - to.strength) * marginWeight
      + (ranked.get(`${move.from}:${move.to}`) || 0) * rankedWeight
      - Math.max(0, 3 - from.strength) * sourcePenalty;

    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function safetyMove(state, safetyOptions = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  return codex.selectSafetyRankedMove(state, {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    topK: 6,
    countWeight: 14,
    minScore: 210,
    splitWeight: 25,
    threatenedWeight: maxEnemy - c.red >= 2 ? 36 : 16,
    ...safetyOptions,
  });
}

function makeModalDesperationGrowth({
  redCut = 4,
  gapCut = 7,
  maxGrowthTurns = 2,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  growthOptions = {},
  safetyOptions = {},
} = {}) {
  let openingHandled = false;
  let growthTurnsRemaining = 0;

  return function modalDesperationGrowth(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) {
      openingHandled = false;
      growthTurnsRemaining = 0;
    }

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

    const start = cloneFromApi(api);
    const c0 = counts(start);
    const maxEnemy0 = Math.max(...BOTS.map(f => c0[f]));
    if (c0.red <= redCut || maxEnemy0 - c0.red >= gapCut) {
      growthTurnsRemaining = Math.max(growthTurnsRemaining, maxGrowthTurns);
    }
    const useGrowth = growthTurnsRemaining > 0;
    if (growthTurnsRemaining > 0) growthTurnsRemaining--;

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= WIN_NODES) return;
      const move = useGrowth
        ? (selectGrowthMove(state, growthOptions) || safetyMove(state, safetyOptions))
        : safetyMove(state, safetyOptions);
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
    ['red4gap7', () => makeModalDesperationGrowth()],
    ['red3gap8', () => makeModalDesperationGrowth({ redCut: 3, gapCut: 8 })],
    ['red5gap7', () => makeModalDesperationGrowth({ redCut: 5, gapCut: 7 })],
    ['oneTurn', () => makeModalDesperationGrowth({ redCut: 4, gapCut: 7, maxGrowthTurns: 1 })],
    ['loose', () => makeModalDesperationGrowth({
      redCut: 5,
      gapCut: 6,
      maxGrowthTurns: 2,
      growthOptions: { minP: 0.18, minScore: 45, captureWeight: 175, rankedWeight: 0.04 },
    })],
    ['cautious', () => makeModalDesperationGrowth({
      redCut: 4,
      gapCut: 8,
      maxGrowthTurns: 1,
      growthOptions: { minP: 0.4, minScore: 90, sourcePenalty: 18 },
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
  const games = Number(argValue('games')) || 80;
  const bases = parseList(argValue('bases'), [1, 1001, 2001]);
  const rows = candidates().map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows) {
    console.log(`${row.name.padEnd(10)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeModalDesperationGrowth,
  selectGrowthMove,
};
