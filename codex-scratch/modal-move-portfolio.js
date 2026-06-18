'use strict';

// Strict scratch experiment: keep the validated modal opening, then let a small
// portfolio of existing local strict selectors propose candidate moves from the
// current public board. The final move is chosen by exact public-state safety
// expectation. No api.rng(), seed recovery, board lookup tables, live-node
// mutation, or benchmark-order state.

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

function moveKey(move) {
  return `${move.from}:${move.to}`;
}

function safetyStatsAfterRedReinforcement(state) {
  const s = cloneState(state);
  reinforce(s, HUMAN);

  let allRisk = 0;
  let beatableRed = 0;
  const redThreatened = new Set();

  for (const n of s.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of s.adj[n.id]) {
      const target = s.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      allRisk += p;
      beatableRed++;
      if (p > 0.45) redThreatened.add(to);
    }
  }

  const c = counts(s);
  const redComps = components(s, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redStrength = s.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));

  return {
    allRisk,
    beatableRed,
    threatened: redThreatened.size,
    red: c.red,
    maxEnemy,
    largest,
    redStrength,
    splits: Math.max(0, redComps.length - 1),
  };
}

function expectedSafetyAfterMove(state, move) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const current = safetyStatsAfterRedReinforcement(state);
  const out = {
    riskDrop: 0,
    threatenedDrop: 0,
    countDrop: 0,
    redGain: 0,
    largestGain: 0,
    strengthGain: 0,
    splitDrop: 0,
    maxEnemyDrop: 0,
  };

  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    const s = safetyStatsAfterRedReinforcement(next);
    out.riskDrop += outcome.prob * (current.allRisk - s.allRisk);
    out.threatenedDrop += outcome.prob * (current.threatened - s.threatened);
    out.countDrop += outcome.prob * (current.beatableRed - s.beatableRed);
    out.redGain += outcome.prob * (s.red - current.red);
    out.largestGain += outcome.prob * (s.largest - current.largest);
    out.strengthGain += outcome.prob * (s.redStrength - current.redStrength);
    out.splitDrop += outcome.prob * (current.splits - s.splits);
    out.maxEnemyDrop += outcome.prob * (current.maxEnemy - s.maxEnemy);
  }

  return out;
}

function safetyConfig(state, config) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  return {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    minScore: 210,
    splitWeight: 25,
    threatenedWeight: maxEnemy - c.red >= 2 ? 36 : 16,
    ...config,
  };
}

function proposalCandidates(state, {
  topRanked = 2,
  includeRankedBooks = true,
  includeSafetyConfigs = true,
  safetySet = 'full',
  useThreshold = false,
} = {}) {
  const byMove = new Map();
  function add(move, sourceScore, vote = 1) {
    if (!move) return;
    const key = moveKey(move);
    const current = byMove.get(key) || { move, votes: 0, sourceScore: 0, bestSource: -Infinity };
    current.votes += vote;
    current.sourceScore += sourceScore;
    current.bestSource = Math.max(current.bestSource, sourceScore);
    byMove.set(key, current);
  }

  if (includeSafetyConfigs) {
    const sets = {
      tiny: [
        { topK: 6, countWeight: 14 },
        { topK: 5, countWeight: 12 },
        { topK: 2, countWeight: 4 },
      ],
      focused: [
        { topK: 6, countWeight: 14 },
        { topK: 6, countWeight: 14, minScore: 220 },
        { topK: 6, countWeight: 14, redGainWeight: 36 },
      ],
      full: [
        { topK: 6, countWeight: 14 },
        { topK: 5, countWeight: 12 },
        { topK: 2, countWeight: 4 },
        { topK: 6, countWeight: 14, minScore: 200 },
        { topK: 6, countWeight: 14, minScore: 220 },
        { topK: 6, countWeight: 14, redGainWeight: 36 },
        { topK: 6, countWeight: 14, largestWeight: 28 },
      ],
    };
    const configs = sets[safetySet] || sets.full;
    for (const config of configs) {
      const move = codex.selectSafetyRankedMove(state, safetyConfig(state, config));
      add(move, 35, 1.25);
    }
  }

  if (includeRankedBooks) {
    const books = [
      codex.DELAYED_MERGE_RANKED_OPTIONS,
      codex.C1_RANKED_OPTIONS,
      codex.C4_RANKED_OPTIONS,
      codex.LEGACY_TUNED_RANKED_OPTIONS,
      codex.TUNED_RANKED_OPTIONS,
    ];
    for (const options of books) {
      let added = 0;
      for (const item of codex.rankedMoveScores(state, { ...codex.FAST_DEFAULTS, ...options })) {
        if (added >= topRanked) break;
        if (useThreshold && item.score < options.threshold) continue;
        add(item.move, Math.max(0, item.score - (options.threshold || 0)) / 8 + 12 / (added + 1));
        added++;
      }
    }
  }

  return [...byMove.values()];
}

function selectPortfolioMove(state, {
  candidateLimit = 8,
  minScore = 210,
  sourceWeight = 0.7,
  voteWeight = 14,
  safetyWeight = 45,
  threatenedWeight = 16,
  countWeight = 14,
  redGainWeight = 28,
  largestWeight = 22,
  strengthWeight = 2,
  splitWeight = 25,
  enemyWeight = 18,
  ...candidateOptions
} = {}) {
  const candidates = proposalCandidates(state, candidateOptions)
    .sort((a, b) => b.votes - a.votes || b.sourceScore - a.sourceScore)
    .slice(0, candidateLimit);

  let best = null;
  let bestScore = -Infinity;
  for (const cand of candidates) {
    const safety = expectedSafetyAfterMove(state, cand.move);
    const score =
      cand.bestSource * sourceWeight
      + cand.votes * voteWeight
      + safety.riskDrop * safetyWeight
      + safety.threatenedDrop * threatenedWeight
      + safety.countDrop * countWeight
      + safety.redGain * redGainWeight
      + safety.largestGain * largestWeight
      + safety.strengthGain * strengthWeight
      + safety.splitDrop * splitWeight
      + safety.maxEnemyDrop * enemyWeight;

    if (score > bestScore) {
      best = cand.move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function makeModalMovePortfolio({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  moveOptions = {},
  fallbackOptions = {},
} = {}) {
  let openingHandled = false;

  return function modalMovePortfolio(api) {
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
      if (counts(state).red >= WIN_NODES) return;
      const c = counts(state);
      const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
      const threatenedWeight = maxEnemy - c.red >= 2 ? 36 : 16;
      const move = selectPortfolioMove(state, moveOptions)
        || codex.selectSafetyRankedMove(state, {
          topK: 6,
          countWeight: 14,
          minScore: 210,
          splitWeight: 25,
          threatenedWeight,
          ...fallbackOptions,
        });
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
    ['tiny', () => makeModalMovePortfolio({
      moveOptions: { includeRankedBooks: false, safetySet: 'tiny', candidateLimit: 3 },
    })],
    ['tinyLoose', () => makeModalMovePortfolio({
      moveOptions: { includeRankedBooks: false, safetySet: 'tiny', candidateLimit: 3, minScore: 185, voteWeight: 10 },
    })],
    ['focused', () => makeModalMovePortfolio({
      moveOptions: { includeRankedBooks: false, safetySet: 'focused', candidateLimit: 3 },
    })],
    ['portfolio', () => makeModalMovePortfolio()],
    ['noRanked', () => makeModalMovePortfolio({
      moveOptions: { includeRankedBooks: false, candidateLimit: 7 },
    })],
    ['loose', () => makeModalMovePortfolio({
      moveOptions: { minScore: 185, sourceWeight: 0.4, voteWeight: 10 },
    })],
    ['strict', () => makeModalMovePortfolio({
      moveOptions: { minScore: 230, candidateLimit: 5, voteWeight: 18 },
    })],
    ['threatHeavy', () => makeModalMovePortfolio({
      moveOptions: { threatenedWeight: 32, safetyWeight: 52, countWeight: 16 },
    })],
    ['growthHeavy', () => makeModalMovePortfolio({
      moveOptions: { redGainWeight: 40, largestWeight: 28, countWeight: 10 },
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
    console.log(`${row.name.padEnd(12)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeModalMovePortfolio,
  selectPortfolioMove,
  proposalCandidates,
};
