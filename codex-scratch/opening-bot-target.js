'use strict';

// Strict scratch experiment: opening selector based on exact public RED battle
// outcomes plus the public first target each bot would choose after RED
// reinforcement. It does not call api.rng(), recover seeds, use board lookup
// tables, mutate live nodes, or track benchmark order.

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

function bestBotMove(state, faction) {
  let best = null;
  for (const n of state.nodes) {
    if (n.owner !== faction || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner === faction || target.strength >= n.strength) continue;
      const candidate = { from: n.id, to, atk: n.strength, def: target.strength };
      if (!best
        || candidate.def < best.def
        || (candidate.def === best.def && candidate.atk > best.atk)
        || (candidate.def === best.def && candidate.atk === best.atk && candidate.from < best.from)
        || (candidate.def === best.def && candidate.atk === best.atk && candidate.from === best.from && candidate.to < best.to)) {
        best = candidate;
      }
    }
  }
  return best;
}

function targetStatsAfterRedReinforcement(state) {
  const s = cloneState(state);
  reinforce(s, HUMAN);

  let allRisk = 0;
  let allCount = 0;
  let botRisk = 0;
  let botCount = 0;
  let botTargetStrengthRisk = 0;
  let botTargetWeakCount = 0;
  const threatened = new Set();
  const botTargeted = new Set();

  for (const n of s.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const nb of s.adj[n.id]) {
      const target = s.nodes[nb];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      allRisk += p;
      allCount++;
      if (p > 0.45) threatened.add(nb);
    }
  }

  for (const bot of BOTS) {
    const move = bestBotMove(s, bot);
    if (!move || s.nodes[move.to].owner !== HUMAN) continue;
    const p = codex.captureProbability(s.nodes[move.from].strength, s.nodes[move.to].strength);
    botRisk += p;
    botCount++;
    botTargetStrengthRisk += p * s.nodes[move.to].strength;
    if (s.nodes[move.to].strength <= 2) botTargetWeakCount++;
    botTargeted.add(move.to);
  }

  const c = counts(s);
  const redComps = components(s, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redStrength = s.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));

  return {
    red: c.red,
    maxEnemy,
    largest,
    redStrength,
    splits: Math.max(0, redComps.length - 1),
    allRisk,
    allCount,
    threatened: threatened.size,
    botRisk,
    botCount,
    botTargetStrengthRisk,
    botTargetWeakCount,
    botTargeted: botTargeted.size,
  };
}

function expectedTargetDelta(state, move) {
  const current = targetStatsAfterRedReinforcement(state);
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const out = Object.fromEntries([
    'redGain',
    'largestGain',
    'strengthGain',
    'splitDrop',
    'maxEnemyDrop',
    'allRiskDrop',
    'allCountDrop',
    'threatenedDrop',
    'botRiskDrop',
    'botCountDrop',
    'botStrengthRiskDrop',
    'botWeakDrop',
    'botTargetedDrop',
  ].map(key => [key, 0]));
  let captureP = 0;

  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const stats = targetStatsAfterRedReinforcement(applyOutcome(state, move, outcome));
    if (outcome.captured) captureP += outcome.prob;
    out.redGain += outcome.prob * (stats.red - current.red);
    out.largestGain += outcome.prob * (stats.largest - current.largest);
    out.strengthGain += outcome.prob * (stats.redStrength - current.redStrength);
    out.splitDrop += outcome.prob * (current.splits - stats.splits);
    out.maxEnemyDrop += outcome.prob * (current.maxEnemy - stats.maxEnemy);
    out.allRiskDrop += outcome.prob * (current.allRisk - stats.allRisk);
    out.allCountDrop += outcome.prob * (current.allCount - stats.allCount);
    out.threatenedDrop += outcome.prob * (current.threatened - stats.threatened);
    out.botRiskDrop += outcome.prob * (current.botRisk - stats.botRisk);
    out.botCountDrop += outcome.prob * (current.botCount - stats.botCount);
    out.botStrengthRiskDrop += outcome.prob * (current.botTargetStrengthRisk - stats.botTargetStrengthRisk);
    out.botWeakDrop += outcome.prob * (current.botTargetWeakCount - stats.botTargetWeakCount);
    out.botTargetedDrop += outcome.prob * (current.botTargeted - stats.botTargeted);
  }

  return { ...out, captureP };
}

function selectBotTargetOpeningMove(state, {
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  minP = 0.55,
  minScore = 35,
  redGainWeight = 54,
  largestWeight = 24,
  strengthWeight = 1,
  splitWeight = 18,
  enemyWeight = 12,
  allRiskWeight = 8,
  allCountWeight = 3,
  threatenedWeight = 8,
  botRiskWeight = 42,
  botCountWeight = 18,
  botStrengthWeight = 8,
  botWeakWeight = 20,
  botTargetedWeight = 14,
  captureWeight = 10,
  rankedWeight = 0.02,
} = {}) {
  const ranked = new Map();
  for (const item of codex.rankedMoveScores(state, rankedOptions)) {
    ranked.set(`${item.move.from}:${item.move.to}`, item.score);
  }

  let best = null;
  let bestScore = -Infinity;
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    if (p < minP) continue;
    const d = expectedTargetDelta(state, move);
    const score =
      d.redGain * redGainWeight
      + d.largestGain * largestWeight
      + d.strengthGain * strengthWeight
      + d.splitDrop * splitWeight
      + d.maxEnemyDrop * enemyWeight
      + d.allRiskDrop * allRiskWeight
      + d.allCountDrop * allCountWeight
      + d.threatenedDrop * threatenedWeight
      + d.botRiskDrop * botRiskWeight
      + d.botCountDrop * botCountWeight
      + d.botStrengthRiskDrop * botStrengthWeight
      + d.botWeakDrop * botWeakWeight
      + d.botTargetedDrop * botTargetedWeight
      + d.captureP * captureWeight
      + (ranked.get(`${move.from}:${move.to}`) || 0) * rankedWeight;

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

function makeBotTargetOpeningGap({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  openingOptions = {},
  safetyOptions = {},
} = {}) {
  let openingHandled = false;

  return function botTargetOpeningGap(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectBotTargetOpeningMove(state, openingOptions);
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = safetyMove(state, safetyOptions);
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
    ['target', () => makeBotTargetOpeningGap()],
    ['targetRisk', () => makeBotTargetOpeningGap({
      openingOptions: { botRiskWeight: 65, botCountWeight: 24, allRiskWeight: 4, redGainWeight: 48 },
    })],
    ['targetGrow', () => makeBotTargetOpeningGap({
      openingOptions: { redGainWeight: 70, largestWeight: 32, botRiskWeight: 28, botCountWeight: 12 },
    })],
    ['targetLoose', () => makeBotTargetOpeningGap({
      openingOptions: { minP: 0.45, minScore: 25, captureWeight: 20 },
    })],
    ['targetStrict', () => makeBotTargetOpeningGap({
      openingOptions: { minP: 0.65, minScore: 50, botWeakWeight: 30, threatenedWeight: 12 },
    })],
    ['hybridRisk', () => makeBotTargetOpeningGap({
      openingOptions: { botRiskWeight: 45, botCountWeight: 18, allRiskWeight: 18, threatenedWeight: 14 },
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
    console.log(`${row.name.padEnd(14)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeBotTargetOpeningGap,
  selectBotTargetOpeningMove,
};
