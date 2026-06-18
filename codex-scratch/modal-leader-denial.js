'use strict';

// Strict scratch experiment: keep the validated modal opening and top-six
// safety midgame, but in visible leader emergencies prefer attacks that reduce
// the current node-count leader. No api.rng(), seed recovery, board lookup,
// live-node mutation, or benchmark-order state.

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

function expectedLeaderStatsAfterMove(state, move, currentCounts) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const currentSafety = safetyStatsAfterRedReinforcement(state);
  const currentMaxEnemy = Math.max(...BOTS.map(f => currentCounts[f]));
  const out = {
    leaderDrop: 0,
    redGain: 0,
    riskDrop: 0,
    threatenedDrop: 0,
    countDrop: 0,
    largestGain: 0,
    strengthGain: 0,
    splitDrop: 0,
    maxEnemyDrop: 0,
    captureP: 0,
  };

  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    const nextCounts = counts(next);
    const nextMaxEnemy = Math.max(...BOTS.map(f => nextCounts[f]));
    const nextSafety = safetyStatsAfterRedReinforcement(next);

    if (outcome.captured) out.captureP += outcome.prob;
    out.leaderDrop += outcome.prob * (currentMaxEnemy - nextMaxEnemy);
    out.redGain += outcome.prob * (nextCounts.red - currentCounts.red);
    out.riskDrop += outcome.prob * (currentSafety.allRisk - nextSafety.allRisk);
    out.threatenedDrop += outcome.prob * (currentSafety.threatened - nextSafety.threatened);
    out.countDrop += outcome.prob * (currentSafety.beatableRed - nextSafety.beatableRed);
    out.largestGain += outcome.prob * (nextSafety.largest - currentSafety.largest);
    out.strengthGain += outcome.prob * (nextSafety.redStrength - currentSafety.redStrength);
    out.splitDrop += outcome.prob * (currentSafety.splits - nextSafety.splits);
    out.maxEnemyDrop += outcome.prob * (currentSafety.maxEnemy - nextSafety.maxEnemy);
  }

  return out;
}

function selectLeaderDenialMove(state, {
  minP = 0.32,
  candidateLimit = 8,
  minScore = 95,
  leaderDropWeight = 135,
  redGainWeight = 30,
  captureWeight = 24,
  safetyWeight = 34,
  threatenedWeight = 10,
  countWeight = 8,
  largestWeight = 16,
  strengthWeight = 1,
  splitWeight = 16,
  maxEnemyDropWeight = 24,
  rankedWeight = 0.02,
} = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const leaders = new Set(BOTS.filter(f => c[f] === maxEnemy));
  const ranked = new Map();
  for (const item of codex.rankedMoveScores(state, { ...codex.FAST_DEFAULTS, ...codex.DELAYED_MERGE_RANKED_OPTIONS })) {
    ranked.set(`${item.move.from}:${item.move.to}`, item.score);
  }

  const candidates = legalMoves(state)
    .map(move => {
      const from = state.nodes[move.from];
      const to = state.nodes[move.to];
      const p = codex.captureProbability(from.strength, to.strength);
      let redAdj = 0;
      for (const nb of state.adj[to.id]) if (state.nodes[nb].owner === HUMAN) redAdj++;
      return {
        move,
        p,
        rough: p * 100
          + redAdj * 18
          + Math.max(0, from.strength - to.strength) * 6
          + (to.strength <= 2 ? 16 : 0)
          + (ranked.get(`${move.from}:${move.to}`) || 0) * 0.02,
      };
    })
    .filter(item => leaders.has(state.nodes[item.move.to].owner) && item.p >= minP)
    .sort((a, b) => b.rough - a.rough)
    .slice(0, candidateLimit);

  let best = null;
  let bestScore = -Infinity;
  for (const item of candidates) {
    const stats = expectedLeaderStatsAfterMove(state, item.move, c);
    const score =
      stats.leaderDrop * leaderDropWeight
      + stats.redGain * redGainWeight
      + stats.captureP * captureWeight
      + stats.riskDrop * safetyWeight
      + stats.threatenedDrop * threatenedWeight
      + stats.countDrop * countWeight
      + stats.largestGain * largestWeight
      + stats.strengthGain * strengthWeight
      + stats.splitDrop * splitWeight
      + stats.maxEnemyDrop * maxEnemyDropWeight
      + (ranked.get(`${item.move.from}:${item.move.to}`) || 0) * rankedWeight;

    if (score > bestScore) {
      best = item.move;
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

function makeModalLeaderDenial({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  leaderCut = 16,
  gapCut = 8,
  denialOptions = {},
  safetyOptions = {},
} = {}) {
  let openingHandled = false;

  return function modalLeaderDenial(api) {
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
      const c = counts(state);
      if (c.red >= WIN_NODES) return;
      const maxEnemy = Math.max(...BOTS.map(f => c[f]));
      const emergency = maxEnemy >= leaderCut || maxEnemy - c.red >= gapCut;
      const move = emergency
        ? (selectLeaderDenialMove(state, denialOptions) || safetyMove(state, safetyOptions))
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
    ['cut16gap8', () => makeModalLeaderDenial()],
    ['cut15gap7', () => makeModalLeaderDenial({ leaderCut: 15, gapCut: 7 })],
    ['cut18gap9', () => makeModalLeaderDenial({ leaderCut: 18, gapCut: 9 })],
    ['aggressive', () => makeModalLeaderDenial({
      leaderCut: 15,
      gapCut: 6,
      denialOptions: { minP: 0.24, minScore: 70, leaderDropWeight: 165, captureWeight: 34 },
    })],
    ['cautious', () => makeModalLeaderDenial({
      leaderCut: 17,
      gapCut: 8,
      denialOptions: { minP: 0.45, minScore: 115, safetyWeight: 48 },
    })],
    ['hardStop', () => makeModalLeaderDenial({
      leaderCut: 16,
      gapCut: 6,
      denialOptions: { minP: 0.3, minScore: 80, leaderDropWeight: 220, maxEnemyDropWeight: 60 },
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
  makeModalLeaderDenial,
  selectLeaderDenialMove,
};
