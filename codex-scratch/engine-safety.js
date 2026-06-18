'use strict';

// Strict scratch experiment: score every legal move by exact expected
// post-reinforcement "engine" value: largest component, border strength,
// follow-up attack capacity, and safety. No api.rng(), seed recovery, live-node
// mutation, board fingerprints, or benchmark-order state.

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
  for (let i = 0; i < largest.length; i++) {
    state.nodes[border[i % border.length]].strength++;
  }
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

function applyOutcome(state, move, outcome) {
  const next = cloneState(state);
  const from = next.nodes[move.from];
  const to = next.nodes[move.to];
  from.strength = outcome.fromStrength;
  if (outcome.captured) to.owner = from.owner;
  to.strength = outcome.toStrength;
  return next;
}

function engineStatsAfterReinforcement(state) {
  const s = cloneState(state);
  reinforce(s, HUMAN);
  const c = counts(s);
  const redComps = components(s, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  let redStrength = 0;
  let borderStrength = 0;
  let borderCount = 0;
  let weakBorder = 0;
  let risk = 0;
  let threatened = 0;
  let goodMoves = 0;
  let goodWeakMoves = 0;

  for (const n of s.nodes) {
    if (n.owner === HUMAN) {
      redStrength += n.strength;
      const hasEnemy = s.adj[n.id].some(nb => s.nodes[nb].owner !== HUMAN);
      if (hasEnemy) {
        borderCount++;
        borderStrength += n.strength;
        if (n.strength <= 2) weakBorder += 3 - n.strength;
      }
      for (const nbId of s.adj[n.id]) {
        const nb = s.nodes[nbId];
        if (nb.owner === HUMAN || n.strength <= 1) continue;
        const p = codex.captureProbability(n.strength, nb.strength);
        if (p > 0.35) {
          goodMoves += p;
          if (nb.strength <= 2) goodWeakMoves += p;
        }
      }
    } else if (n.strength > 1) {
      for (const nbId of s.adj[n.id]) {
        const nb = s.nodes[nbId];
        if (nb.owner !== HUMAN || n.strength <= nb.strength) continue;
        const p = codex.captureProbability(n.strength, nb.strength);
        risk += p;
        if (p > 0.45) threatened++;
      }
    }
  }

  return {
    red: c.red,
    maxEnemy: Math.max(...BOTS.map(f => c[f])),
    largest,
    redStrength,
    borderStrength,
    borderCount,
    weakBorder,
    splits: Math.max(0, redComps.length - 1),
    risk,
    threatened,
    goodMoves,
    goodWeakMoves,
  };
}

function expectedEngineDelta(state, move) {
  const current = engineStatsAfterReinforcement(state);
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const out = Object.fromEntries(Object.keys(current).map(key => [key, 0]));
  let captureP = 0;

  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    const stats = engineStatsAfterReinforcement(next);
    for (const key of Object.keys(current)) {
      out[key] += outcome.prob * (stats[key] - current[key]);
    }
    if (outcome.captured) captureP += outcome.prob;
  }

  return { ...out, captureP };
}

function selectEngineMove(state, {
  minScore = 200,
  minP = 0.25,
  candidateLimit = 5,
  rankedLimit = 4,
  rawLimit = 4,
  redWeight = 36,
  largestWeight = 45,
  strengthWeight = 3,
  borderStrengthWeight = 2,
  borderCountWeight = 6,
  weakBorderWeight = 20,
  riskWeight = 55,
  threatenedWeight = 20,
  goodMoveWeight = 14,
  goodWeakWeight = 12,
  splitWeight = 35,
  enemyWeight = 18,
  rankedWeight = 0.18,
  captureWeight = 35,
} = {}) {
  const ranked = new Map();
  const candidates = new Map();
  for (const item of codex.rankedMoveScores(state, codex.DELAYED_MERGE_RANKED_OPTIONS)) {
    ranked.set(`${item.move.from}:${item.move.to}`, item.score);
    if (candidates.size < rankedLimit) candidates.set(`${item.move.from}:${item.move.to}`, item.move);
  }

  const raw = [];
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    if (p < minP) continue;
    let redAdj = 0;
    for (const nbId of state.adj[to.id]) if (state.nodes[nbId].owner === HUMAN) redAdj++;
    raw.push({
      move,
      score: p * 100 + redAdj * 18 + (from.strength - to.strength) * 5 + (to.strength <= 2 ? 14 : 0),
    });
  }
  raw.sort((a, b) => b.score - a.score);
  for (const item of raw.slice(0, rawLimit)) {
    candidates.set(`${item.move.from}:${item.move.to}`, item.move);
  }

  let best = null;
  let bestScore = -Infinity;
  for (const move of [...candidates.values()].slice(0, candidateLimit)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    if (p < minP) continue;
    const delta = expectedEngineDelta(state, move);
    const score =
      delta.red * redWeight
      + delta.largest * largestWeight
      + delta.redStrength * strengthWeight
      + delta.borderStrength * borderStrengthWeight
      + delta.borderCount * borderCountWeight
      - delta.weakBorder * weakBorderWeight
      - delta.risk * riskWeight
      - delta.threatened * threatenedWeight
      + delta.goodMoves * goodMoveWeight
      + delta.goodWeakMoves * goodWeakWeight
      - delta.splits * splitWeight
      - delta.maxEnemy * enemyWeight
      + delta.captureP * captureWeight
      + (ranked.get(`${move.from}:${move.to}`) || 0) * rankedWeight;

    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function makeEngineSafety({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  modalOpening = false,
  openingOptions = {},
  engineOptions = {},
  fallbackSafety = false,
} = {}) {
  let openingHandled = false;

  return function engineSafety(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = modalOpening
          ? codex.selectModalOpeningMove(state, openingOptions)
          : codex.selectOpeningDefenseMove(state, {
            rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
            minP: 0.55,
            minScore: 60,
            riskWeight: 55,
            ...openingOptions,
          });
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      let move = selectEngineMove(state, engineOptions);
      if (!move && fallbackSafety) {
        move = codex.selectSafetyRankedMove(state, {
          rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
          minScore: 210,
          splitWeight: 25,
        });
      }
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function makeModalOpeningEarlyEngine({
  earlyTurns = 1,
  engineOptions = { minScore: 220, minP: 0.35, candidateLimit: 3, rankedLimit: 3, rawLimit: 2 },
  maxOpeningAttacks = 2,
  maxAttacks = 120,
} = {}) {
  let openingHandled = false;
  let earlyTurnsRemaining = 0;

  return function modalOpeningEarlyEngine(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) {
      openingHandled = false;
      earlyTurnsRemaining = earlyTurns;
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

    const useEngine = earlyTurnsRemaining > 0;
    if (earlyTurnsRemaining > 0) earlyTurnsRemaining--;

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= WIN_NODES) return;

      let move;
      if (useEngine) {
        move = selectEngineMove(state, engineOptions);
      } else {
        const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
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

const candidateFactories = {
  modal: () => codex.codexModalOpeningGap,
  modalEarlyEngine: () => makeModalOpeningEarlyEngine(),
  modalEarlyEngineLoose: () => makeModalOpeningEarlyEngine({ engineOptions: { minScore: 180, minP: 0.25, candidateLimit: 3, rankedLimit: 3, rawLimit: 2 } }),
  modalEngineA: () => makeEngineSafety({ modalOpening: true, engineOptions: { minScore: 200, minP: 0.25 } }),
  modalEngineB: () => makeEngineSafety({ modalOpening: true, engineOptions: { minScore: 160, minP: 0.2, riskWeight: 70 } }),
  modalEngineC: () => makeEngineSafety({ modalOpening: true, engineOptions: { minScore: 220, minP: 0.35, largestWeight: 60 } }),
  modalFallback: () => makeEngineSafety({ modalOpening: true, fallbackSafety: true, engineOptions: { minScore: 230, minP: 0.35 } }),
  safetyK2: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }),
  threat36: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, threatenedWeight: 36 }),
  engineA: () => makeEngineSafety({ engineOptions: { minScore: 200, minP: 0.25 } }),
  engineB: () => makeEngineSafety({ engineOptions: { minScore: 160, minP: 0.2, riskWeight: 70 } }),
  engineC: () => makeEngineSafety({ engineOptions: { minScore: 220, minP: 0.35, largestWeight: 60 } }),
  engineFallback: () => makeEngineSafety({ fallbackSafety: true, engineOptions: { minScore: 230, minP: 0.35 } }),
};

function main() {
  const games = Number(process.argv[2]) || 80;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 10001);

  const rows = [];
  for (const [name, factory] of Object.entries(candidateFactories)) {
    let total = 0;
    let totalMs = 0;
    const parts = [];
    for (const seedBase of bases) {
      const result = sim.scorePolicy(factory(), { games, seedBase });
      total += result.wins;
      totalMs += result.totalMs;
      parts.push(`${seedBase}:${result.wins}/${games}`);
    }
    rows.push({ name, total, parts, msPerGame: totalMs / (games * bases.length) });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    console.log(`${row.name.padEnd(14)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeEngineSafety,
  makeModalOpeningEarlyEngine,
  selectEngineMove,
};
