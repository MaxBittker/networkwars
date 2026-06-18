'use strict';

// Strict scratch experiment: make at most a few high-confidence opening attacks
// only when they reduce visible first-round bot threats to RED, then play the
// current delayed-merge ranked policy on later turns.

const G = require('../game');
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

function redThreatStatsAfterReinforce(state) {
  const s = cloneState(state);
  G.reinforce(s, HUMAN);

  let count = 0;
  let risk = 0;
  let maxP = 0;
  let expectedNodeLoss = 0;
  const threatenedRed = new Set();

  for (const n of s.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of s.adj[n.id]) {
      const target = s.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      count++;
      risk += p;
      maxP = Math.max(maxP, p);
      expectedNodeLoss += p;
      if (p > 0.45) threatenedRed.add(to);
    }
  }

  return { count, risk, maxP, expectedNodeLoss, threatenedRed: threatenedRed.size };
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

function expectedAfterMove(state, move) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const current = redThreatStatsAfterReinforce(state);
  const c = counts(state);

  let risk = 0;
  let count = 0;
  let threatened = 0;
  let redCount = 0;
  let captureP = 0;

  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    const stats = redThreatStatsAfterReinforce(next);
    const nextCounts = counts(next);
    risk += outcome.prob * stats.risk;
    count += outcome.prob * stats.count;
    threatened += outcome.prob * stats.threatenedRed;
    redCount += outcome.prob * nextCounts.red;
    if (outcome.captured) captureP += outcome.prob;
  }

  return {
    riskDrop: current.risk - risk,
    countDrop: current.count - count,
    threatenedDrop: current.threatenedRed - threatened,
    redGain: redCount - c.red,
    captureP,
  };
}

function openingDefenseMove(state, {
  minP = 0.7,
  minScore = 1.0,
  riskWeight = 55,
  countWeight = 5,
  threatenedWeight = 16,
  redGainWeight = 24,
  rankedWeight = 0.03,
} = {}) {
  const ranked = new Map();
  for (const item of codex.rankedMoveScores(state, codex.DELAYED_MERGE_RANKED_OPTIONS)) {
    ranked.set(`${item.move.from}:${item.move.to}`, item.score);
  }

  let best = null;
  let bestScore = -Infinity;
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const captureP = codex.captureProbability(from.strength, to.strength);
    if (captureP < minP) continue;

    const expected = expectedAfterMove(state, move);
    const score =
      expected.riskDrop * riskWeight
      + expected.countDrop * countWeight
      + expected.threatenedDrop * threatenedWeight
      + expected.redGain * redGainWeight
      + (ranked.get(`${move.from}:${move.to}`) || 0) * rankedWeight;

    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function playRankedTurn(api, options = codex.DELAYED_MERGE_RANKED_OPTIONS) {
  const opts = { ...codex.FAST_DEFAULTS, ...options };
  for (let attacks = 0; attacks < opts.maxAttacks; attacks++) {
    const state = cloneFromApi(api);
    if (counts(state).red >= WIN_NODES) return;
    const move = codex.selectRankedMove(state, opts);
    if (!move) return;
    api.attack(move.from, move.to);
  }
}

function makeOpeningDefenseDelay(options = {}) {
  let openingHandled = false;

  return function openingDefenseDelay(api) {
    const start = cloneFromApi(api);
    if (isOpening(start)) openingHandled = false;

    if (!openingHandled && isOpening(start)) {
      openingHandled = true;
      for (let i = 0; i < (options.maxOpeningAttacks || 1); i++) {
        const state = cloneFromApi(api);
        const move = openingDefenseMove(state, options);
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    playRankedTurn(api, options.rankedOptions || codex.DELAYED_MERGE_RANKED_OPTIONS);
  };
}

function main() {
  const games = Number(process.argv[2]) || 180;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 2001, 10001, 50001);

  const candidates = [
    ['delayedMerge', () => codex.makeDelayedRankedStrategy(codex.DELAYED_MERGE_RANKED_OPTIONS)],
  ];
  for (const maxOpeningAttacks of [1, 2]) {
    for (const minP of [0.55, 0.65, 0.75, 0.85]) {
      for (const minScore of [0, 8, 18, 35, 60]) {
        for (const riskWeight of [35, 55, 85]) {
          const name = `a${maxOpeningAttacks}/p${minP}/s${minScore}/r${riskWeight}`;
          candidates.push([name, () => makeOpeningDefenseDelay({
            maxOpeningAttacks,
            minP,
            minScore,
            riskWeight,
          })]);
        }
      }
    }
  }

  const rows = [];
  for (const [name, factory] of candidates) {
    let total = 0;
    let ms = 0;
    const parts = [];
    for (const seedBase of bases) {
      const r = sim.scorePolicy(factory(), { games, seedBase });
      total += r.wins;
      ms += r.totalMs;
      parts.push(`${seedBase}:${r.wins}/${games}`);
    }
    rows.push({ name, total, parts, msPerGame: ms / (games * bases.length) });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows.slice(0, 35)) {
    console.log(`${row.name.padEnd(22)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeOpeningDefenseDelay,
  openingDefenseMove,
};

