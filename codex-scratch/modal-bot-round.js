'use strict';

// Strict scratch experiment: score top ranked RED moves by exact public RED
// battle outcomes, then a cheap deterministic approximation of the next bot
// round. The bot model applies each greedy bot attack with the most likely
// public battle outcome. No api.rng(), seed recovery, board lookup tables,
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

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function winner(state) {
  const c = counts(state);
  for (const f of FACTIONS) if (c[f] >= WIN_NODES) return f;
  const alive = FACTIONS.filter(f => c[f] > 0);
  return alive.length === 1 ? alive[0] : null;
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

function bestBotMove(state, faction) {
  let best = null;
  for (const n of state.nodes) {
    if (n.owner !== faction || n.strength <= 1) continue;
    for (const nb of state.adj[n.id]) {
      const t = state.nodes[nb];
      if (t.owner === faction || t.strength >= n.strength) continue;
      const cand = { from: n.id, to: nb, atk: n.strength, def: t.strength };
      if (!best
        || cand.def < best.def
        || (cand.def === best.def && cand.atk > best.atk)
        || (cand.def === best.def && cand.atk === best.atk && cand.from < best.from)
        || (cand.def === best.def && cand.atk === best.atk && cand.from === best.from && cand.to < best.to)) {
        best = cand;
      }
    }
  }
  return best;
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

function expectedFailureStrength(attackerStrength, defenderStrength) {
  let p = 0;
  let total = 0;
  for (const outcome of codex.battleOutcomes(attackerStrength, defenderStrength)) {
    if (outcome.captured) continue;
    p += outcome.prob;
    total += outcome.prob * outcome.toStrength;
  }
  return p ? total / p : defenderStrength;
}

function modeledOutcome(attackerStrength, defenderStrength, {
  mode = 'modal',
  captureThreshold = 0.55,
} = {}) {
  if (mode === 'modal') return modalOutcome(attackerStrength, defenderStrength);

  const captureP = codex.captureProbability(attackerStrength, defenderStrength);
  if (captureP >= captureThreshold) {
    return {
      captured: true,
      fromStrength: 1,
      toStrength: Math.max(1, Math.round(codex.expectedCapturedStrength(attackerStrength, defenderStrength))),
    };
  }

  return {
    captured: false,
    fromStrength: 1,
    toStrength: Math.max(1, Math.round(expectedFailureStrength(attackerStrength, defenderStrength))),
  };
}

function runModalBotTurn(state, faction, botModel) {
  if (counts(state)[faction] === 0) return;
  let guard = 0;
  while (guard++ < 120 && !winner(state)) {
    const move = bestBotMove(state, faction);
    if (!move) break;
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    applyOutcomeInPlace(state, move, modeledOutcome(from.strength, to.strength, botModel));
  }
  if (!winner(state)) reinforce(state, faction);
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

function modalRoundStats(state, botModel) {
  const s = cloneState(state);
  reinforce(s, HUMAN);
  for (const bot of BOTS) {
    runModalBotTurn(s, bot, botModel);
    if (winner(s)) break;
  }

  const c = counts(s);
  const redComps = components(s, HUMAN);
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

function expectedModalDelta(state, move, botModel) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const current = modalRoundStats(state, botModel);
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
    const stats = modalRoundStats(applyOutcome(state, move, outcome), botModel);
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

function selectModalOpeningMove(state, {
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  minP = 0.55,
  minScore = 40,
  redGainWeight = 60,
  largestWeight = 28,
  strengthWeight = 1,
  splitWeight = 20,
  enemyWeight = 14,
  riskWeight = 18,
  countWeight = 6,
  threatenedWeight = 12,
  rankedWeight = 0.02,
  botModel = {},
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
    const captureP = codex.captureProbability(from.strength, to.strength);
    if (captureP < minP) continue;

    const d = expectedModalDelta(state, move, botModel);
    const score =
      d.redGain * redGainWeight
      + d.largestGain * largestWeight
      + d.strengthGain * strengthWeight
      + d.splitDrop * splitWeight
      + d.maxEnemyDrop * enemyWeight
      + d.riskDrop * riskWeight
      + d.countDrop * countWeight
      + d.threatenedDrop * threatenedWeight
      + (ranked.get(`${move.from}:${move.to}`) || 0) * rankedWeight;

    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function selectModalRoundMove(state, {
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  topK = 4,
  minScore = 210,
  rankWeight = 1,
  redGainWeight = 38,
  largestWeight = 24,
  strengthWeight = 1.5,
  splitWeight = 30,
  enemyWeight = 20,
  riskWeight = 24,
  countWeight = 8,
  threatenedWeight = 16,
  botModel = {},
} = {}) {
  const options = { ...codex.FAST_DEFAULTS, ...rankedOptions };
  const ranked = codex.rankedMoveScores(state, options).slice(0, topK);
  if (!ranked.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const item of ranked) {
    const d = expectedModalDelta(state, item.move, botModel);
    const score =
      item.score * rankWeight
      + d.redGain * redGainWeight
      + d.largestGain * largestWeight
      + d.strengthGain * strengthWeight
      + d.splitDrop * splitWeight
      + d.maxEnemyDrop * enemyWeight
      + d.riskDrop * riskWeight
      + d.countDrop * countWeight
      + d.threatenedDrop * threatenedWeight;
    if (score > bestScore) {
      best = item.move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function makeModalOpeningGapStrategy({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  openingOptions = {},
  openingOptionsByAttack = [],
  gapCut = 2,
  highThreatenedWeight = 36,
  lowThreatenedWeight = 16,
  safetyOptions = {},
} = {}) {
  let openingHandled = false;

  return function modalOpeningGapStrategy(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectModalOpeningMove(state, {
          ...openingOptions,
          ...(openingOptionsByAttack[i] || {}),
        });
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
      const move = codex.selectSafetyRankedMove(state, {
        rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
        topK: 6,
        countWeight: 14,
        minScore: 210,
        splitWeight: 25,
        ...safetyOptions,
        threatenedWeight,
      });
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function makeModalOpeningEarlyRoundStrategy({
  earlyTurns = 1,
  modalMoveOptions = { topK: 2 },
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  openingOptions = {},
  gapCut = 2,
  highThreatenedWeight = 36,
  lowThreatenedWeight = 16,
  safetyOptions = {},
} = {}) {
  let openingHandled = false;
  let earlyTurnsRemaining = 0;

  return function modalOpeningEarlyRoundStrategy(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) {
      openingHandled = false;
      earlyTurnsRemaining = earlyTurns;
    }

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectModalOpeningMove(state, openingOptions);
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    const useModal = earlyTurnsRemaining > 0;
    if (earlyTurnsRemaining > 0) earlyTurnsRemaining--;

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= WIN_NODES) return;

      let move;
      if (useModal) {
        move = selectModalRoundMove(state, modalMoveOptions);
      } else {
        const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
        const threatenedWeight = maxEnemy - c.red >= gapCut ? highThreatenedWeight : lowThreatenedWeight;
        move = codex.selectSafetyRankedMove(state, {
          rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
          topK: 6,
          countWeight: 14,
          minScore: 210,
          splitWeight: 25,
          ...safetyOptions,
          threatenedWeight,
        });
      }
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function makeModalBotRoundStrategy({
  maxOpeningAttacks = 2,
  openingRiskWeight = 75,
  maxAttacks = 120,
  ...moveOptions
} = {}) {
  let openingHandled = false;

  return function modalBotRoundStrategy(api) {
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
      const move = selectModalRoundMove(state, moveOptions);
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
  const out = [
    ['current', () => codex.codexSafetyGap2Threat],
    ['modalOpen', () => makeModalOpeningGapStrategy()],
    ['modalEarly1', () => makeModalOpeningEarlyRoundStrategy({ earlyTurns: 1 })],
    ['modalEarly2', () => makeModalOpeningEarlyRoundStrategy({ earlyTurns: 2 })],
    ['modal-k3', () => makeModalBotRoundStrategy({ topK: 3 })],
    ['modal-k4', () => makeModalBotRoundStrategy({ topK: 4 })],
    ['modal-k6', () => makeModalBotRoundStrategy({ topK: 6 })],
  ];

  for (const redGainWeight of [24, 32, 44, 56]) {
    out.push([`red${redGainWeight}`, () => makeModalBotRoundStrategy({ topK: 4, redGainWeight })]);
  }
  for (const riskWeight of [0, 12, 24, 40]) {
    out.push([`risk${riskWeight}`, () => makeModalBotRoundStrategy({ topK: 4, riskWeight })]);
  }
  for (const minScore of [180, 200, 210, 230]) {
    out.push([`min${minScore}`, () => makeModalBotRoundStrategy({ topK: 4, minScore })]);
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
  const games = Number(argValue('games')) || 60;
  const bases = parseList(argValue('bases'), [1, 1001, 2001]);
  const rows = candidates().map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows) {
    console.log(`${row.name.padEnd(14)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeModalBotRoundStrategy,
  makeModalOpeningGapStrategy,
  makeModalOpeningEarlyRoundStrategy,
  selectModalRoundMove,
  selectModalOpeningMove,
  modalRoundStats,
};
