'use strict';

// Strict scratch experiment: one-step expected "attack versus stop" strategy.
// For each candidate attack it branches exact public RED battle outcomes, then
// compares the resulting board after RED reinforcement plus one deterministic
// modal bot round. It never calls api.rng(), recovers seeds, mutates live nodes,
// memorizes boards, or uses benchmark-order state.

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

function winner(state) {
  const c = counts(state);
  for (const faction of FACTIONS) if (c[faction] >= WIN_NODES) return faction;
  const alive = FACTIONS.filter(faction => c[faction] > 0);
  return alive.length === 1 ? alive[0] : null;
}

function components(state, faction) {
  const seen = new Set();
  const comps = [];
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
    comps.push(comp);
  }
  return comps;
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

function legalMoves(state, faction = HUMAN) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      if (state.nodes[to].owner !== faction) moves.push({ from: n.id, to });
    }
  }
  return moves;
}

function isOpening(state) {
  const c = counts(state);
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

function modalOutcome(fromStrength, toStrength) {
  let best = null;
  for (const outcome of codex.battleOutcomes(fromStrength, toStrength)) {
    if (!best
      || outcome.prob > best.prob
      || (outcome.prob === best.prob && outcome.captured && !best.captured)) {
      best = outcome;
    }
  }
  return best;
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

function runModalBotTurn(state, faction) {
  if (counts(state)[faction] === 0) return;
  for (let guard = 0; guard < 1000; guard++) {
    const move = bestBotMove(state, faction);
    if (!move) break;
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    applyOutcomeInPlace(state, move, modalOutcome(from.strength, to.strength));
    if (winner(state)) return;
  }
  reinforce(state, faction);
}

function finishModalRound(state) {
  const next = cloneState(state);
  if (!winner(next)) reinforce(next, HUMAN);
  for (const bot of BOTS) {
    if (winner(next)) break;
    runModalBotTurn(next, bot);
  }
  return next;
}

function finishRedReinforcement(state) {
  const next = cloneState(state);
  if (!winner(next)) reinforce(next, HUMAN);
  return next;
}

function boardStats(state) {
  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
  const secondEnemy = BOTS.map(faction => c[faction]).sort((a, b) => b - a)[1];
  let redStrength = 0;
  let borderStrength = 0;
  let weakBorder = 0;
  let attackPotential = 0;
  let risk = 0;
  let threatened = 0;

  for (const n of state.nodes) {
    if (n.owner === HUMAN) {
      redStrength += n.strength;
      const border = state.adj[n.id].some(nb => state.nodes[nb].owner !== HUMAN);
      if (border) {
        borderStrength += n.strength;
        if (n.strength <= 2) weakBorder += 3 - n.strength;
      }
      if (n.strength > 1) {
        for (const nb of state.adj[n.id]) {
          const target = state.nodes[nb];
          if (target.owner === HUMAN) continue;
          const p = codex.captureProbability(n.strength, target.strength);
          if (p >= 0.35) attackPotential += p * (target.strength <= 2 ? 1.35 : 1);
        }
      }
      continue;
    }

    if (n.strength <= 1) continue;
    for (const nb of state.adj[n.id]) {
      const target = state.nodes[nb];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      risk += p;
      if (p > 0.45) threatened++;
    }
  }

  return {
    red: c.red,
    maxEnemy,
    secondEnemy,
    largest,
    splits: Math.max(0, redComps.length - 1),
    redStrength,
    borderStrength,
    weakBorder,
    attackPotential,
    risk,
    threatened,
  };
}

function boardValue(state, {
  redWeight = 310,
  leaderWeight = 190,
  largestWeight = 175,
  strengthWeight = 3,
  borderWeight = 4,
  potentialWeight = 24,
  riskWeight = 85,
  threatenedWeight = 22,
  splitWeight = 70,
  weakBorderWeight = 18,
} = {}) {
  const won = winner(state);
  if (won === HUMAN) return 100000;
  if (won) return -100000;

  const s = boardStats(state);
  return s.red * redWeight
    - s.maxEnemy * leaderWeight
    + (s.red - s.maxEnemy) * 95
    + (s.maxEnemy - s.secondEnemy) * -20
    + s.largest * largestWeight
    + s.redStrength * strengthWeight
    + s.borderStrength * borderWeight
    + s.attackPotential * potentialWeight
    - s.risk * riskWeight
    - s.threatened * threatenedWeight
    - s.splits * splitWeight
    - s.weakBorder * weakBorderWeight;
}

function candidateMoves(state, {
  rankedLimit = 6,
  rawLimit = 6,
  candidateLimit = 8,
  minP = 0.2,
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
} = {}) {
  const candidates = new Map();
  const rankedScores = new Map();
  for (const item of codex.rankedMoveScores(state, { ...codex.FAST_DEFAULTS, ...rankedOptions })) {
    const key = `${item.move.from}:${item.move.to}`;
    rankedScores.set(key, item.score);
    if (candidates.size < rankedLimit) candidates.set(key, item.move);
  }

  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
  const raw = [];
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
        + Math.max(0, from.strength - to.strength) * 7
        + redAdj * 20
        + (c[to.owner] === maxEnemy ? 18 : 0)
        + (to.strength <= 2 ? 14 : 0),
    });
  }
  raw.sort((a, b) => b.score - a.score);
  for (const item of raw.slice(0, rawLimit)) {
    candidates.set(`${item.move.from}:${item.move.to}`, item.move);
  }

  return [...candidates.values()]
    .map(move => ({ move, rankedScore: rankedScores.get(`${move.from}:${move.to}`) || 0 }))
    .slice(0, candidateLimit);
}

function selectRoundDeltaMove(state, {
  minGain = 18,
  valueOptions = {},
  rankedBonus = 0.04,
  horizon = 'reinforce',
  ...candidateOptions
} = {}) {
  const finish = horizon === 'modalRound' ? finishModalRound : finishRedReinforcement;
  const stopValue = boardValue(finish(state), valueOptions);
  let best = null;
  let bestGain = -Infinity;

  for (const item of candidateMoves(state, candidateOptions)) {
    const from = state.nodes[item.move.from];
    const to = state.nodes[item.move.to];
    let expected = 0;
    for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
      expected += outcome.prob * boardValue(finish(applyOutcome(state, item.move, outcome)), valueOptions);
    }
    const gain = expected - stopValue + item.rankedScore * rankedBonus;
    if (gain > bestGain) {
      best = item.move;
      bestGain = gain;
    }
  }

  return best && bestGain >= minGain ? best : null;
}

function makeRoundDeltaStrategy({
  modalOpening = false,
  maxOpeningAttacks = 2,
  maxAttacks = 75,
  moveOptions = {},
} = {}) {
  let openingHandled = false;

  return function roundDelta(api) {
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
      if (counts(state).red >= WIN_NODES) return;
      const move = selectRoundDeltaMove(state, moveOptions);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map(Number).filter(Number.isFinite);
}

function parseNames(value) {
  if (!value) return [];
  return value.split(',').map(name => name.trim()).filter(Boolean);
}

function argValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function candidates() {
  return [
    ['modal', () => codex.codexModalOpeningGap],
    ['deltaPure', () => makeRoundDeltaStrategy({
      moveOptions: { rankedLimit: 5, rawLimit: 4, candidateLimit: 6 },
    })],
    ['deltaModal', () => makeRoundDeltaStrategy({
      modalOpening: true,
      moveOptions: { rankedLimit: 5, rawLimit: 4, candidateLimit: 6 },
    })],
    ['deltaModalLoose', () => makeRoundDeltaStrategy({
      modalOpening: true,
      moveOptions: { minGain: -8, minP: 0.2, rankedLimit: 5, rawLimit: 5, candidateLimit: 7 },
    })],
    ['deltaModalTight', () => makeRoundDeltaStrategy({
      modalOpening: true,
      moveOptions: { minGain: 45, minP: 0.28, rankedLimit: 4, rawLimit: 3, candidateLimit: 5 },
    })],
    ['deltaModalRisk', () => makeRoundDeltaStrategy({
      modalOpening: true,
      moveOptions: {
        minGain: 12,
        rankedLimit: 5,
        rawLimit: 4,
        candidateLimit: 6,
        valueOptions: { riskWeight: 120, threatenedWeight: 32 },
      },
    })],
    ['deltaModalRace', () => makeRoundDeltaStrategy({
      modalOpening: true,
      moveOptions: {
        minGain: 8,
        rankedLimit: 5,
        rawLimit: 4,
        candidateLimit: 6,
        valueOptions: { redWeight: 360, leaderWeight: 215, largestWeight: 155 },
      },
    })],
    ['deltaModalFullRound', () => makeRoundDeltaStrategy({
      modalOpening: true,
      maxAttacks: 35,
      moveOptions: {
        horizon: 'modalRound',
        minGain: 10,
        minP: 0.25,
        rankedLimit: 3,
        rawLimit: 2,
        candidateLimit: 3,
      },
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
  return {
    name,
    total,
    totalGames: games * bases.length,
    parts,
    msPerGame: totalMs / (games * bases.length),
  };
}

function main() {
  const games = Number(argValue('games')) || 60;
  const bases = parseList(argValue('bases'), [1, 1001, 2001]);
  const nameFilter = new Set(parseNames(argValue('names')));
  const selected = candidates()
    .filter(([name]) => name !== 'deltaModalFullRound' || nameFilter.has(name))
    .filter(([name]) => !nameFilter.size || nameFilter.has(name));
  const rows = selected.map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of rows) {
    console.log(`${row.name.padEnd(16)} ${String(row.total).padStart(4)}/${row.totalGames}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeRoundDeltaStrategy,
  selectRoundDeltaMove,
};
