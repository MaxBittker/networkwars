'use strict';

// Strict scratch experiment: keep the validated modal opening and exact-safety
// midgame, but bias the ranked candidate shortlist by public bot turn order.
// No api.rng(), seed recovery, board lookup tables, live-node mutation, or
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

function ownerBiasScore(owner, countsByOwner, bias = {}) {
  const base = bias[owner] || 0;
  const scaled = bias.scaled || 0;
  return base + base * countsByOwner[owner] * scaled;
}

function selectOrderSafetyMove(state, {
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  topK = 6,
  candidatePool = 10,
  ownerBias = {},
  safetyWeight = 45,
  threatenedWeight = 16,
  countWeight = 14,
  redGainWeight = 28,
  largestWeight = 22,
  strengthWeight = 2,
  splitWeight = 25,
  enemyWeight = 18,
  minScore = 210,
} = {}) {
  const c = counts(state);
  const options = { ...codex.FAST_DEFAULTS, ...rankedOptions };
  const ranked = codex.rankedMoveScores(state, options)
    .map(item => ({
      ...item,
      shortlistScore: item.score + ownerBiasScore(state.nodes[item.move.to].owner, c, ownerBias),
    }))
    .sort((a, b) => b.shortlistScore - a.shortlistScore)
    .slice(0, candidatePool)
    .slice(0, topK);
  if (!ranked.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const item of ranked) {
    const safety = expectedSafetyAfterMove(state, item.move);
    const score =
      item.shortlistScore
      + safety.riskDrop * safetyWeight
      + safety.threatenedDrop * threatenedWeight
      + safety.countDrop * countWeight
      + safety.redGain * redGainWeight
      + safety.largestGain * largestWeight
      + safety.strengthGain * strengthWeight
      + safety.splitDrop * splitWeight
      + safety.maxEnemyDrop * enemyWeight;

    if (score > bestScore) {
      best = item.move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function makeModalOrderSafety({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  gapCut = 2,
  highThreatenedWeight = 36,
  lowThreatenedWeight = 16,
  ...moveOptions
} = {}) {
  let openingHandled = false;

  return function modalOrderSafety(api) {
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
      const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
      const threatenedWeight = maxEnemy - c.red >= gapCut ? highThreatenedWeight : lowThreatenedWeight;
      const move = selectOrderSafetyMove(state, {
        ...moveOptions,
        threatenedWeight,
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
  const biasSets = [
    ['modal', null],
    ['early', { green: 9, yellow: 6, blue: 3, purple: 0 }],
    ['earlyStrong', { green: 18, yellow: 12, blue: 6, purple: 0 }],
    ['depriorPurple', { green: 4, yellow: 3, blue: 4, purple: -8 }],
    ['antiBlue', { green: 4, yellow: 0, blue: 8, purple: -2 }],
    ['antiGreenBlue', { green: 8, yellow: 0, blue: 8, purple: -3 }],
    ['antiPurpleLate', { green: 0, yellow: 2, blue: 5, purple: 8 }],
  ];

  const out = [['modal', () => codex.codexModalOpeningGap]];
  for (const [name, ownerBias] of biasSets.slice(1)) {
    out.push([name, () => makeModalOrderSafety({ ownerBias })]);
    out.push([`${name}Scaled`, () => makeModalOrderSafety({ ownerBias: { ...ownerBias, scaled: 0.2 } })]);
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
  const bases = parseList(argValue('bases'), [1, 1001, 2001]);
  const rows = candidates().map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows) {
    console.log(`${row.name.padEnd(22)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeModalOrderSafety,
  selectOrderSafetyMove,
};
