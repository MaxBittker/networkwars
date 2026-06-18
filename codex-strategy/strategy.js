'use strict';

// A RED policy for Network Wars. It only relies on the public policy API from
// sim.js, so it can be dropped into the existing harness without modifying it.

const ATTACKER_WIN_P = 0.55;
const HUMAN = 'red';
const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const WIN_NODES = 24;

const OUTCOME_CACHE = new Map();
const EXACT_OUTCOME_LIMIT = 80;
const LARGE_BATTLE_SAMPLES = 32;

const DEFAULT_WEIGHTS = {
  redCount: 150,
  largestComponent: 95,
  redStrength: 5,
  largestStrength: 6,
  borderStrength: 5,
  splitPenalty: 42,
  weakBorderPenalty: 13,
  botThreatPenalty: 95,
  enemyCountPenalty: 17,
  nextAttackBonus: 16,
  killBonus: 90,
  winBonus: 1000000,
  attackThreshold: 7,
  maxAttacks: 90,
};

function cloneFromApi(api) {
  const nodes = api.nodes.map(n => ({
    id: n.id,
    x: n.x,
    y: n.y,
    owner: n.owner,
    strength: n.strength,
  }));
  const adj = nodes.map(n => api.neighbors(n.id).slice());
  return { nodes, adj };
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
  const out = {};
  for (const f of FACTIONS) out[f] = 0;
  for (const n of state.nodes) out[n.owner]++;
  return out;
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
        if (!seen.has(nb) && state.nodes[nb].owner === faction) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

function largestComponent(state, faction) {
  let best = [];
  for (const comp of components(state, faction)) {
    if (comp.length > best.length) best = comp;
  }
  return best;
}

function reinforce(state, faction) {
  const comp = largestComponent(state, faction);
  if (!comp.length) return;
  const border = comp
    .filter(id => state.adj[id].some(nb => state.nodes[nb].owner !== faction))
    .sort((a, b) => a - b);
  if (!border.length) return;
  for (let i = 0; i < comp.length; i++) {
    state.nodes[border[i % border.length]].strength++;
  }
}

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

function battleOutcomes(attackerStrength, defenderStrength) {
  const key = `${attackerStrength}:${defenderStrength}`;
  const cached = OUTCOME_CACHE.get(key);
  if (cached) return cached;

  if (attackerStrength + defenderStrength > EXACT_OUTCOME_LIMIT) {
    const outcomes = sampleLargeBattleOutcomes(attackerStrength, defenderStrength);
    if (OUTCOME_CACHE.size < 5000) OUTCOME_CACHE.set(key, outcomes);
    return outcomes;
  }

  const p = ATTACKER_WIN_P;
  const q = 1 - p;
  const outcomes = [];

  for (let attackerLosses = 0; attackerLosses <= attackerStrength - 2; attackerLosses++) {
    const prob = choose(defenderStrength + attackerLosses - 1, attackerLosses)
      * (p ** defenderStrength)
      * (q ** attackerLosses);
    outcomes.push({
      prob,
      captured: true,
      fromStrength: 1,
      toStrength: attackerStrength - attackerLosses - 1,
    });
  }

  for (let defenderLosses = 0; defenderLosses <= defenderStrength - 1; defenderLosses++) {
    const prob = choose(attackerStrength - 2 + defenderLosses, defenderLosses)
      * (q ** (attackerStrength - 1))
      * (p ** defenderLosses);
    outcomes.push({
      prob,
      captured: false,
      fromStrength: 1,
      toStrength: defenderStrength - defenderLosses,
    });
  }

  OUTCOME_CACHE.set(key, outcomes);
  return outcomes;
}

function sampleLargeBattleOutcomes(attackerStrength, defenderStrength) {
  const outcomes = [];
  for (let i = 0; i < LARGE_BATTLE_SAMPLES; i++) {
    let a = attackerStrength;
    let d = defenderStrength;
    const rng = makeDeterministicRng(attackerStrength, defenderStrength, i);
    while (a > 1 && d > 0) {
      if (rng() < ATTACKER_WIN_P) d--;
      else a--;
    }
    outcomes.push({
      prob: 1 / LARGE_BATTLE_SAMPLES,
      captured: d === 0,
      fromStrength: 1,
      toStrength: d === 0 ? a - 1 : d,
    });
  }
  return outcomes;
}

function makeDeterministicRng(a, d, salt) {
  let s = ((a * 2654435761) ^ (d * 1597334677) ^ (salt * 3812015801)) >>> 0;
  return function rng() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function captureProbability(attackerStrength, defenderStrength) {
  let p = 0;
  for (const outcome of battleOutcomes(attackerStrength, defenderStrength)) {
    if (outcome.captured) p += outcome.prob;
  }
  return p;
}

function expectedCapturedStrength(attackerStrength, defenderStrength) {
  let p = 0;
  let total = 0;
  for (const outcome of battleOutcomes(attackerStrength, defenderStrength)) {
    if (!outcome.captured) continue;
    p += outcome.prob;
    total += outcome.prob * outcome.toStrength;
  }
  return p ? total / p : 0;
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

function applyOutcomeInPlace(state, move, outcome) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  from.strength = outcome.fromStrength;
  if (outcome.captured) to.owner = from.owner;
  to.strength = outcome.toStrength;
}

function scoreAfterRedReinforcement(state, weights) {
  const s = cloneState(state);
  reinforce(s, HUMAN);
  return evaluatePosition(s, weights);
}

function evaluatePosition(state, weights) {
  const c = counts(state);
  if (c.red >= WIN_NODES) return weights.winBonus + c.red * 10000;
  if (c.red === 0) return -weights.winBonus;

  const redComps = components(state, HUMAN);
  let largest = [];
  for (const comp of redComps) if (comp.length > largest.length) largest = comp;
  const largestSet = new Set(largest);

  let redStrength = 0;
  let largestStrength = 0;
  let borderStrength = 0;
  let weakBorderPenalty = 0;
  let botThreatPenalty = 0;
  let nextAttackBonus = 0;

  for (const n of state.nodes) {
    if (n.owner === HUMAN) {
      redStrength += n.strength;
      if (largestSet.has(n.id)) largestStrength += n.strength;

      const enemyNeighbors = state.adj[n.id]
        .map(id => state.nodes[id])
        .filter(nb => nb.owner !== HUMAN);
      if (enemyNeighbors.length) {
        borderStrength += n.strength;
        if (n.strength <= 2) weakBorderPenalty += 3 - n.strength;
      }

      for (const enemy of enemyNeighbors) {
        if (enemy.strength > n.strength) {
          const pCap = captureProbability(enemy.strength, n.strength);
          botThreatPenalty += pCap * (9 + (largestSet.has(n.id) ? 5 : 0));
        }
      }
    }
  }

  for (const move of legalMoves(state, HUMAN)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const pCap = captureProbability(from.strength, to.strength);
    if (pCap > 0.35) nextAttackBonus += pCap * (1 + (to.strength <= 2 ? 0.7 : 0));
  }

  let score = 0;
  score += c.red * weights.redCount;
  score += largest.length * weights.largestComponent;
  score += redStrength * weights.redStrength;
  score += largestStrength * weights.largestStrength;
  score += borderStrength * weights.borderStrength;
  score -= Math.max(0, redComps.length - 1) * weights.splitPenalty;
  score -= weakBorderPenalty * weights.weakBorderPenalty;
  score -= botThreatPenalty * weights.botThreatPenalty;
  score += nextAttackBonus * weights.nextAttackBonus;

  for (const faction of BOTS) {
    score -= c[faction] * weights.enemyCountPenalty;
    if (c[faction] === 0) score += weights.killBonus;
  }

  return score;
}

function expectedMoveScore(state, move, weights) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  let expected = 0;
  for (const outcome of battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    expected += outcome.prob * scoreAfterRedReinforcement(next, weights);
  }
  return expected;
}

function selectMove(state, weights = DEFAULT_WEIGHTS) {
  const base = scoreAfterRedReinforcement(state, weights);
  let best = null;
  let bestScore = -Infinity;

  for (const move of legalMoves(state, HUMAN)) {
    const score = expectedMoveScore(state, move, weights);
    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }

  if (!best || bestScore <= base + weights.attackThreshold) return null;
  return best;
}

function makeStrategy(weightOverrides = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...weightOverrides };
  return function codexStrategy(api) {
    let attacks = 0;
    while (attacks++ < weights.maxAttacks) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = selectMove(state, weights);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function componentLabels(state, faction) {
  const labels = new Map();
  const sizes = [];
  const comps = components(state, faction);
  comps.forEach((comp, idx) => {
    sizes[idx] = comp.length;
    for (const id of comp) labels.set(id, idx);
  });
  let largestId = -1;
  for (let i = 0; i < sizes.length; i++) {
    if (largestId === -1 || sizes[i] > sizes[largestId]) largestId = i;
  }
  return { labels, sizes, largestId };
}

const FAST_DEFAULTS = {
  capture: 145,
  weakTarget: 24,
  margin: 7,
  source: 2,
  redAdj: 34,
  merge: 62,
  largestTouch: 42,
  enemyCount: 4,
  eliminate: 85,
  exposure: 19,
  lowChancePenalty: 70,
  strongTargetPenalty: 3,
  threshold: 122,
  maxAttacks: 120,
};

function rankedMoveScores(state, options = FAST_DEFAULTS) {
  const c = counts(state);
  const labels = componentLabels(state, HUMAN);
  const moves = legalMoves(state, HUMAN);
  const scored = [];

  for (const move of moves) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const pCap = captureProbability(from.strength, to.strength);
    const expectedStrength = expectedCapturedStrength(from.strength, to.strength);
    const touching = new Set();
    let redAdj = 0;
    let exposure = 0;

    for (const nbId of state.adj[to.id]) {
      const nb = state.nodes[nbId];
      if (nb.owner === HUMAN) {
        redAdj++;
        if (labels.labels.has(nb.id)) touching.add(labels.labels.get(nb.id));
      } else if (nb.id !== from.id && nb.strength > expectedStrength) {
        exposure += captureProbability(nb.strength, Math.max(1, expectedStrength));
      }
    }

    const sourceComp = labels.labels.get(from.id);
    if (sourceComp !== undefined) touching.add(sourceComp);

    const mergeCount = Math.max(0, touching.size - 1);
    const touchesLargest = touching.has(labels.largestId);
    const margin = from.strength - to.strength;
    const weakTarget = 1 / Math.max(1, to.strength);
    const strongTargetPenalty = Math.max(0, to.strength - 3);

    let score = 0;
    score += pCap * options.capture;
    score += weakTarget * options.weakTarget;
    score += margin * options.margin;
    score += Math.log2(Math.max(2, from.strength)) * options.source;
    score += redAdj * options.redAdj;
    score += mergeCount * options.merge;
    if (touchesLargest) score += options.largestTouch;
    score += c[to.owner] * options.enemyCount;
    if (c[to.owner] === 1) score += options.eliminate;
    score -= exposure * options.exposure;
    score -= Math.max(0, 0.45 - pCap) * options.lowChancePenalty;
    score -= strongTargetPenalty * options.strongTargetPenalty;

    if (c.red >= WIN_NODES - 1) score += 100000;

    scored.push({ move, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function selectRankedMove(state, options = FAST_DEFAULTS) {
  const scored = rankedMoveScores(state, options);
  const best = scored[0];
  if (!best) return null;
  if (best.score < options.threshold) return null;
  return best.move;
}

function makeRankedStrategy(optionOverrides = {}) {
  const options = { ...FAST_DEFAULTS, ...optionOverrides };
  return function rankedStrategy(api) {
    let attacks = 0;
    while (attacks++ < options.maxAttacks) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = selectRankedMove(state, options);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function makeDelayedRankedStrategy(optionOverrides = {}, { waitTurns = 1 } = {}) {
  const policy = makeRankedStrategy(optionOverrides);
  let waitsRemaining = 0;

  return function delayedRankedStrategy(api) {
    if (isOpeningCounts(api)) waitsRemaining = waitTurns;

    if (waitsRemaining > 0) {
      waitsRemaining--;
      return;
    }

    return policy(api);
  };
}

function redThreatStatsAfterRedReinforcement(state) {
  const s = cloneState(state);
  reinforce(s, HUMAN);

  let count = 0;
  let risk = 0;
  const threatenedRed = new Set();

  for (const n of s.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of s.adj[n.id]) {
      const target = s.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = captureProbability(n.strength, target.strength);
      count++;
      risk += p;
      if (p > 0.45) threatenedRed.add(to);
    }
  }

  return { count, risk, threatenedRed: threatenedRed.size };
}

function expectedOpeningDefense(state, move) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const current = redThreatStatsAfterRedReinforcement(state);
  const c = counts(state);

  let risk = 0;
  let count = 0;
  let threatened = 0;
  let redCount = 0;
  let captureP = 0;

  for (const outcome of battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    const stats = redThreatStatsAfterRedReinforcement(next);
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

function selectOpeningDefenseMove(state, {
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
  minP = 0.55,
  minScore = 60,
  riskWeight = 55,
  countWeight = 5,
  threatenedWeight = 16,
  redGainWeight = 24,
  rankedWeight = 0.03,
} = {}) {
  const ranked = new Map();
  for (const item of rankedMoveScores(state, rankedOptions)) {
    ranked.set(`${item.move.from}:${item.move.to}`, item.score);
  }

  let best = null;
  let bestScore = -Infinity;
  for (const move of legalMoves(state, HUMAN)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const captureP = captureProbability(from.strength, to.strength);
    if (captureP < minP) continue;

    const expected = expectedOpeningDefense(state, move);
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

function makeOpeningDefenseDelayStrategy({
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
  maxOpeningAttacks = 2,
  minP = 0.55,
  minScore = 60,
  riskWeight = 55,
  maxAttacks = 120,
} = {}) {
  const policy = makeRankedStrategy({ ...rankedOptions, maxAttacks });
  let openingHandled = false;

  return function openingDefenseDelayStrategy(api) {
    const freshOpening = isOpeningCounts(api);
    if (freshOpening) openingHandled = false;

    if (!openingHandled && freshOpening) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const current = cloneFromApi(api);
        const move = selectOpeningDefenseMove(current, {
          rankedOptions,
          minP,
          minScore,
          riskWeight,
        });
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    return policy(api);
  };
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
      const p = captureProbability(n.strength, target.strength);
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

  for (const outcome of battleOutcomes(from.strength, to.strength)) {
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

function selectSafetyRankedMove(state, {
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
  topK = 2,
  safetyWeight = 45,
  threatenedWeight = 16,
  countWeight = 4,
  redGainWeight = 28,
  largestWeight = 22,
  strengthWeight = 2,
  splitWeight = 35,
  enemyWeight = 18,
  minScore = null,
} = {}) {
  const options = { ...FAST_DEFAULTS, ...rankedOptions };
  const ranked = rankedMoveScores(state, options).slice(0, topK);
  if (!ranked.length) return null;

  const threshold = minScore ?? options.threshold;
  let best = null;
  let bestScore = -Infinity;

  for (const item of ranked) {
    const safety = expectedSafetyAfterMove(state, item.move);
    const score =
      item.score
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

  return best && bestScore >= threshold ? best : null;
}

function makeSafetyK2Strategy({
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  ...safetyOptions
} = {}) {
  let openingHandled = false;

  return function safetyK2Strategy(api) {
    const freshOpening = isOpeningCounts(api);
    if (freshOpening) openingHandled = false;

    if (!openingHandled && freshOpening) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectOpeningDefenseMove(state, {
          rankedOptions,
          minP: 0.55,
          minScore: 60,
          riskWeight: 55,
        });
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = selectSafetyRankedMove(state, { rankedOptions, ...safetyOptions });
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function makeGapThreatSafetyStrategy({
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  openingOptions = {},
  gapCut = 2,
  highThreatenedWeight = 36,
  lowThreatenedWeight = 16,
  ...safetyOptions
} = {}) {
  let openingHandled = false;

  return function gapThreatSafetyStrategy(api) {
    const freshOpening = isOpeningCounts(api);
    if (freshOpening) openingHandled = false;

    if (!openingHandled && freshOpening) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectOpeningDefenseMove(state, {
          rankedOptions,
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
      const c = counts(state);
      if (c.red >= WIN_NODES) return;
      const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
      const threatenedWeight = maxEnemy - c.red >= gapCut ? highThreatenedWeight : lowThreatenedWeight;
      const move = selectSafetyRankedMove(state, {
        rankedOptions,
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

function modalOutcome(attackerStrength, defenderStrength) {
  let best = null;
  for (const outcome of battleOutcomes(attackerStrength, defenderStrength)) {
    if (!best
      || outcome.prob > best.prob
      || (outcome.prob === best.prob && outcome.captured && !best.captured)
      || (outcome.prob === best.prob && outcome.captured === best.captured && outcome.toStrength > best.toStrength)) {
      best = outcome;
    }
  }
  return best;
}

function runModalBotTurn(state, faction) {
  if (counts(state)[faction] === 0) return;
  let guard = 0;
  while (guard++ < 120 && !winner(state)) {
    const move = bestBotMove(state, faction);
    if (!move) break;
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    applyOutcomeInPlace(state, move, modalOutcome(from.strength, to.strength));
  }
  if (!winner(state)) reinforce(state, faction);
}

function modalRiskStats(state) {
  let risk = 0;
  let count = 0;
  const threatened = new Set();
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = captureProbability(n.strength, target.strength);
      risk += p;
      count++;
      if (p > 0.45) threatened.add(to);
    }
  }
  return { risk, count, threatened: threatened.size };
}

function modalRoundStats(state) {
  const s = cloneState(state);
  reinforce(s, HUMAN);
  for (const bot of BOTS) {
    runModalBotTurn(s, bot);
    if (winner(s)) break;
  }

  const c = counts(s);
  const redComps = components(s, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redStrength = s.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const risk = modalRiskStats(s);

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

function expectedModalDelta(state, move) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const current = modalRoundStats(state);
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

  for (const outcome of battleOutcomes(from.strength, to.strength)) {
    const stats = modalRoundStats(applyOutcome(state, move, outcome));
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
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
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
} = {}) {
  const ranked = new Map();
  for (const item of rankedMoveScores(state, rankedOptions)) {
    ranked.set(`${item.move.from}:${item.move.to}`, item.score);
  }

  let best = null;
  let bestScore = -Infinity;
  for (const move of legalMoves(state, HUMAN)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const captureP = captureProbability(from.strength, to.strength);
    if (captureP < minP) continue;

    const d = expectedModalDelta(state, move);
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

function moveKey(move) {
  return `${move.from}:${move.to}`;
}

function modalScoutCandidates(state, baseline, topK, rankedOptions) {
  const seen = new Set();
  const out = [];
  function add(move) {
    if (!move) return;
    const key = moveKey(move);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(move);
  }

  add(baseline);
  for (const item of rankedMoveScores(state, {
    ...FAST_DEFAULTS,
    ...rankedOptions,
  }).slice(0, topK)) {
    add(item.move);
  }
  return out;
}

function scoreModalDelta(d, weights) {
  return d.redGain * weights.redGain
    + d.largestGain * weights.largest
    + d.strengthGain * weights.strength
    + d.splitDrop * weights.split
    + d.maxEnemyDrop * weights.enemy
    + d.riskDrop * weights.risk
    + d.countDrop * weights.count
    + d.threatenedDrop * weights.threatened;
}

function selectModalScoutMove(state, {
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
  topK = 3,
  minEdge = 25,
  minScoreWithoutBaseline = 45,
  gapCut = 2,
  highThreatenedWeight = 36,
  lowThreatenedWeight = 16,
  safetyOptions = {},
  weights = {
    redGain: 70,
    largest: 28,
    strength: 1,
    split: 20,
    enemy: 16,
    risk: 18,
    count: 6,
    threatened: 12,
  },
} = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(faction => c[faction]));
  const threatenedWeight = maxEnemy - c.red >= gapCut ? highThreatenedWeight : lowThreatenedWeight;
  const baseline = selectSafetyRankedMove(state, {
    rankedOptions,
    topK: 6,
    countWeight: 14,
    minScore: 210,
    splitWeight: 25,
    ...safetyOptions,
    threatenedWeight,
  });
  const candidates = modalScoutCandidates(state, baseline, topK, rankedOptions);
  if (!candidates.length) return null;

  let best = null;
  let bestScore = -Infinity;
  let baselineScore = baseline ? -Infinity : null;
  const baselineKey = baseline && moveKey(baseline);

  for (const move of candidates) {
    const score = scoreModalDelta(expectedModalDelta(state, move), weights);
    if (baselineKey && moveKey(move) === baselineKey) baselineScore = score;
    if (score > bestScore) {
      best = move;
      bestScore = score;
    }
  }

  if (!baseline) return bestScore >= minScoreWithoutBaseline ? best : null;
  if (moveKey(best) === baselineKey) return baseline;
  return bestScore >= baselineScore + minEdge ? best : baseline;
}

function makeModalOpeningGapStrategy({
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  openingOptions = {},
  gapCut = 2,
  highThreatenedWeight = 36,
  lowThreatenedWeight = 16,
  ...safetyOptions
} = {}) {
  let openingHandled = false;

  return function modalOpeningGapStrategy(api) {
    const freshOpening = isOpeningCounts(api);
    if (freshOpening) openingHandled = false;

    if (!openingHandled && freshOpening) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectModalOpeningMove(state, {
          rankedOptions,
          ...openingOptions,
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
      const move = selectSafetyRankedMove(state, {
        rankedOptions,
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

function makeModalScoutStrategy({
  rankedOptions = DELAYED_MERGE_RANKED_OPTIONS,
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  openingOptions = {},
  scoutOptions = {},
  gapCut = 2,
  highThreatenedWeight = 36,
  lowThreatenedWeight = 16,
  ...safetyOptions
} = {}) {
  let openingHandled = false;

  return function modalScoutStrategy(api) {
    const freshOpening = isOpeningCounts(api);
    if (freshOpening) openingHandled = false;

    if (!openingHandled && freshOpening) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectModalOpeningMove(state, {
          rankedOptions,
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
      const move = selectModalScoutMove(state, {
        rankedOptions,
        gapCut,
        highThreatenedWeight,
        lowThreatenedWeight,
        safetyOptions,
        ...scoutOptions,
      });
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function winner(state) {
  const c = counts(state);
  for (const f of FACTIONS) if (c[f] >= WIN_NODES) return f;
  const alive = FACTIONS.filter(f => c[f] > 0);
  return alive.length === 1 ? alive[0] : null;
}

function resolveBattleSample(state, move, rng) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  let a = from.strength;
  let d = to.strength;
  while (a > 1 && d > 0) {
    if (rng() < ATTACKER_WIN_P) d--;
    else a--;
  }
  from.strength = 1;
  if (d === 0) {
    to.owner = from.owner;
    to.strength = a - 1;
    return true;
  }
  to.strength = d;
  return false;
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

function runBotTurnSample(state, faction, rng) {
  if (counts(state)[faction] === 0) return;
  let guard = 0;
  while (guard++ < 1000) {
    const move = bestBotMove(state, faction);
    if (!move) break;
    resolveBattleSample(state, move, rng);
    if (winner(state)) return;
  }
  reinforce(state, faction);
}

function finishRoundSample(state, rng) {
  reinforce(state, HUMAN);
  if (winner(state)) return;
  for (const bot of BOTS) {
    runBotTurnSample(state, bot, rng);
    if (winner(state)) return;
  }
}

function playoutRedTurn(state, rng, options, maxAttacks = 80) {
  let attacks = 0;
  while (attacks++ < maxAttacks && !winner(state)) {
    const move = selectRankedMove(state, options);
    if (!move) return;
    resolveBattleSample(state, move, rng);
  }
}

function playoutValue(state, rng, options, horizonTurns) {
  for (let t = 0; t < horizonTurns; t++) {
    const w = winner(state);
    if (w) return w === HUMAN ? 1 : 0;
    playoutRedTurn(state, rng, options);
    const afterRed = winner(state);
    if (afterRed) return afterRed === HUMAN ? 1 : 0;
    finishRoundSample(state, rng);
  }

  const w = winner(state);
  if (w) return w === HUMAN ? 1 : 0;

  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  return Math.max(0, Math.min(1, 0.5
    + (c.red - Math.max(c.green, c.yellow, c.blue, c.purple)) / 36
    + (largest - 6) / 40));
}

function stateHash(state, salt = 0) {
  let h = (0x811C9DC5 ^ salt) >>> 0;
  for (const n of state.nodes) {
    const ownerIdx = FACTIONS.indexOf(n.owner) + 1;
    h ^= ((n.id + 1) * 17) ^ (ownerIdx * 131) ^ (n.strength * 8191);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function rngFromState(state, salt = 0) {
  const seed = stateHash(state, salt) || 1;
  return makeDeterministicRng(seed, seed ^ 0xA5A5A5A5, 0xC0DE);
}

const LEGACY_TUNED_RANKED_OPTIONS = {
  threshold: 184.966,
  capture: 97.712,
  weakTarget: 39.979,
  margin: 9.575,
  source: 1.539,
  redAdj: 50.51,
  merge: 84.483,
  largestTouch: 33.024,
  enemyCount: 8.746,
  eliminate: 104.618,
  exposure: 48.101,
  lowChancePenalty: 67.034,
  strongTargetPenalty: 0,
  maxAttacks: 120,
};

const C1_RANKED_OPTIONS = {
  threshold: 220.775,
  capture: 44.687,
  weakTarget: 69.885,
  margin: 9.789,
  source: 1.754,
  redAdj: 59.153,
  merge: 114.472,
  largestTouch: 77.164,
  enemyCount: 9.322,
  eliminate: 0,
  exposure: 60.487,
  lowChancePenalty: 140.411,
  strongTargetPenalty: 0,
  maxAttacks: 120,
};

const C4_RANKED_OPTIONS = {
  threshold: 221.259,
  capture: 41.626,
  weakTarget: 16.58,
  margin: 3.155,
  source: 9.863,
  redAdj: 34.636,
  merge: 75.442,
  largestTouch: 65.481,
  enemyCount: 13.635,
  eliminate: 195.996,
  exposure: 41.79,
  lowChancePenalty: 126.886,
  strongTargetPenalty: 4.498,
  maxAttacks: 120,
};

const DELAYED_MERGE_RANKED_OPTIONS = {
  threshold: 235,
  capture: 28.795,
  weakTarget: 3.674,
  margin: 10.874,
  source: 9.522,
  redAdj: 68.557,
  merge: 185,
  largestTouch: 11.775,
  enemyCount: 25.161,
  eliminate: 92.279,
  exposure: 103.136,
  lowChancePenalty: 216.851,
  strongTargetPenalty: 4.551,
  maxAttacks: 120,
};

const TUNED_RANKED_OPTIONS = C4_RANKED_OPTIONS;

const PORTFOLIO_OPTIONS = [
  TUNED_RANKED_OPTIONS,
  C1_RANKED_OPTIONS,
  {
    ...FAST_DEFAULTS,
    threshold: 135,
    capture: 150,
    redAdj: 44,
    merge: 85,
    largestTouch: 58,
    exposure: 25,
    enemyCount: 2,
  },
  {
    ...FAST_DEFAULTS,
    threshold: 92,
    capture: 128,
    weakTarget: 34,
    redAdj: 24,
    merge: 45,
    exposure: 10,
    lowChancePenalty: 42,
  },
  {
    ...FAST_DEFAULTS,
    threshold: 58,
    capture: 92,
    weakTarget: 42,
    margin: 3,
    redAdj: 18,
    merge: 28,
    largestTouch: 20,
    exposure: 5,
    lowChancePenalty: 20,
  },
];

function openingOkCount(state) {
  let ok = 0;
  for (const move of legalMoves(state, HUMAN)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    if (captureProbability(from.strength, to.strength) > 0.4) ok++;
  }
  return ok;
}

function isOpeningCounts(api) {
  const c = api.counts();
  return FACTIONS.every(faction => c[faction] === 6)
    && api.nodes.every(node => node.strength >= 1 && node.strength <= 5);
}

function makeOpeningSelectorStrategy({
  threshold = 13,
  highOpportunity = C1_RANKED_OPTIONS,
  fallback = C4_RANKED_OPTIONS,
} = {}) {
  const highPolicy = makeRankedStrategy(highOpportunity);
  const fallbackPolicy = makeRankedStrategy(fallback);
  let mode = null;

  return function openingSelectorStrategy(api) {
    if (mode === null || isOpeningCounts(api)) {
      mode = openingOkCount(cloneFromApi(api)) >= threshold ? 'high' : 'fallback';
    }
    if (mode === 'high') highPolicy(api);
    else fallbackPolicy(api);
  };
}

function makePressureStrategy({
  threshold = 13,
  highOpportunity = C1_RANKED_OPTIONS,
  fallback = C4_RANKED_OPTIONS,
  leaderBonus = 13,
  endDrop = 14,
  maxAttacks = 120,
} = {}) {
  const highOptions = { ...FAST_DEFAULTS, ...highOpportunity };
  const fallbackOptions = { ...FAST_DEFAULTS, ...fallback };
  let mode = null;

  return function pressureStrategy(api) {
    if (mode === null || isOpeningCounts(api)) {
      mode = openingOkCount(cloneFromApi(api)) >= threshold ? 'high' : 'fallback';
    }

    const options = mode === 'high' ? highOptions : fallbackOptions;
    let attacks = 0;

    while (attacks++ < maxAttacks) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= WIN_NODES) return;

      const enemyCounts = BOTS.map(faction => c[faction]).sort((a, b) => b - a);
      const maxEnemy = enemyCounts[0];
      const secondEnemy = enemyCounts[1];
      const dynamicThreshold = options.threshold - Math.max(0, c.red - 14) * endDrop;

      let best = null;
      let bestScore = -Infinity;

      for (const item of rankedMoveScores(state, options)) {
        const to = state.nodes[item.move.to];
        let score = item.score;

        if (c[to.owner] === maxEnemy) {
          const leaderGap = Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1);
          score += leaderBonus * leaderGap;
        }

        if (score > bestScore) {
          best = item.move;
          bestScore = score;
        }
      }

      if (!best || bestScore < dynamicThreshold) return;
      api.attack(best.from, best.to);
    }
  };
}

function makeDelayedPressureStrategy({
  threshold = 13,
  highOpportunity = C1_RANKED_OPTIONS,
  fallback = C4_RANKED_OPTIONS,
  leaderBonus = 13,
  endDrop = 14,
  waitTurns = 1,
  maxAttacks = 120,
} = {}) {
  const highOptions = { ...FAST_DEFAULTS, ...highOpportunity };
  const fallbackOptions = { ...FAST_DEFAULTS, ...fallback };
  let mode = null;
  let waitsRemaining = 0;

  return function delayedPressureStrategy(api) {
    if (mode === null || isOpeningCounts(api)) {
      mode = openingOkCount(cloneFromApi(api)) >= threshold ? 'high' : 'fallback';
      waitsRemaining = waitTurns;
    }

    if (waitsRemaining > 0) {
      waitsRemaining--;
      return;
    }

    const options = mode === 'high' ? highOptions : fallbackOptions;
    let attacks = 0;

    while (attacks++ < maxAttacks) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= WIN_NODES) return;

      const enemyCounts = BOTS.map(faction => c[faction]).sort((a, b) => b - a);
      const maxEnemy = enemyCounts[0];
      const secondEnemy = enemyCounts[1];
      const dynamicThreshold = options.threshold - Math.max(0, c.red - 14) * endDrop;

      let best = null;
      let bestScore = -Infinity;

      for (const item of rankedMoveScores(state, options)) {
        const to = state.nodes[item.move.to];
        let score = item.score;

        if (c[to.owner] === maxEnemy) {
          const leaderGap = Math.max(0, maxEnemy - Math.max(c.red, secondEnemy) + 1);
          score += leaderBonus * leaderGap;
        }

        if (score > bestScore) {
          best = item.move;
          bestScore = score;
        }
      }

      if (!best || bestScore < dynamicThreshold) return;
      api.attack(best.from, best.to);
    }
  };
}

function candidateActions(state, topPerPolicy) {
  const actions = [{ stop: true, key: 'stop' }];
  const seen = new Set(['stop']);

  for (const options of PORTFOLIO_OPTIONS) {
    for (const item of rankedMoveScores(state, options).slice(0, topPerPolicy)) {
      const key = `${item.move.from}:${item.move.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push({ move: item.move, key });
    }
  }

  const weakest = legalMoves(state, HUMAN)
    .sort((a, b) => state.nodes[a.to].strength - state.nodes[b.to].strength
      || state.nodes[b.from].strength - state.nodes[a.from].strength)[0];
  if (weakest) {
    const key = `${weakest.from}:${weakest.to}`;
    if (!seen.has(key)) actions.push({ move: weakest, key });
  }

  return actions;
}

function makeMonteCarloStrategy(optionOverrides = {}) {
  const options = {
    rollouts: 7,
    horizonTurns: 16,
    topPerPolicy: 2,
    maxActions: 14,
    rolloutPolicy: TUNED_RANKED_OPTIONS,
    attackMargin: 0.015,
    maxAttacks: 45,
    ...optionOverrides,
  };

  return function monteCarloStrategy(api) {
    let attacks = 0;
    while (attacks++ < options.maxAttacks) {
      const state = cloneFromApi(api);
      if (winner(state)) return;
      const actions = candidateActions(state, options.topPerPolicy).slice(0, options.maxActions);
      if (actions.length <= 1) return;

      let bestAction = actions[0];
      let bestValue = -Infinity;
      let stopValue = -Infinity;

      for (const action of actions) {
        let total = 0;
        for (let i = 0; i < options.rollouts; i++) {
          const s = cloneState(state);
          const rng = rngFromState(state, (i + 1) * 4099 + action.key.length * 97);
          if (action.move) resolveBattleSample(s, action.move, rng);
          if (action.stop) {
            finishRoundSample(s, rng);
          } else if (!winner(s)) {
            playoutRedTurn(s, rng, options.rolloutPolicy);
            if (!winner(s)) finishRoundSample(s, rng);
          }
          total += playoutValue(s, rng, options.rolloutPolicy, options.horizonTurns);
        }
        const value = total / options.rollouts;
        if (action.stop) stopValue = value;
        if (value > bestValue) {
          bestValue = value;
          bestAction = action;
        }
      }

      if (!bestAction.move || bestValue <= stopValue + options.attackMargin) return;
      api.attack(bestAction.move.from, bestAction.move.to);
    }
  };
}

const codexStrategy = makeOpeningSelectorStrategy();
const codexOpening = codexStrategy;
const codexPressure = makePressureStrategy();
const codexDelayedPressure = makeDelayedPressureStrategy();
const codexDelayedMerge = makeDelayedRankedStrategy(DELAYED_MERGE_RANKED_OPTIONS);
const codexOpeningDefenseDelay = makeOpeningDefenseDelayStrategy();
const codexSafetyK2 = makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 });
const codexSafetyThreat36 = makeSafetyK2Strategy({
  minScore: 210,
  splitWeight: 25,
  threatenedWeight: 36,
});
const codexSafetyGap2ThreatFast = makeGapThreatSafetyStrategy();
const codexSafetyGap2ThreatTop5 = makeGapThreatSafetyStrategy({ topK: 5, countWeight: 12 });
const codexSafetyGap2ThreatTop6 = makeGapThreatSafetyStrategy({ topK: 6, countWeight: 14 });
const codexSafetyGap2Threat = makeGapThreatSafetyStrategy({
  topK: 6,
  countWeight: 14,
  openingOptions: { riskWeight: 75 },
});
const codexModalOpeningGap = makeModalOpeningGapStrategy();
const codexModalScout = makeModalScoutStrategy();
const codexRanked = makeRankedStrategy(TUNED_RANKED_OPTIONS);
const codexTuned = makeRankedStrategy(TUNED_RANKED_OPTIONS);
const codexC1 = makeRankedStrategy(C1_RANKED_OPTIONS);
const codexC4 = makeRankedStrategy(C4_RANKED_OPTIONS);
const codexMonteCarlo = makeMonteCarloStrategy();

module.exports = {
  codexStrategy,
  codexOpening,
  codexPressure,
  codexDelayedPressure,
  codexDelayedMerge,
  codexOpeningDefenseDelay,
  codexSafetyK2,
  codexSafetyThreat36,
  codexSafetyGap2ThreatFast,
  codexSafetyGap2ThreatTop5,
  codexSafetyGap2ThreatTop6,
  codexSafetyGap2Threat,
  codexModalOpeningGap,
  codexModalScout,
  codexRanked,
  codexTuned,
  codexC1,
  codexC4,
  codexMonteCarlo,
  makeStrategy,
  makeRankedStrategy,
  makeDelayedRankedStrategy,
  makeOpeningDefenseDelayStrategy,
  makeSafetyK2Strategy,
  makeGapThreatSafetyStrategy,
  makeModalOpeningGapStrategy,
  makeModalScoutStrategy,
  makeOpeningSelectorStrategy,
  makePressureStrategy,
  makeDelayedPressureStrategy,
  makeMonteCarloStrategy,
  selectMove,
  selectRankedMove,
  rankedMoveScores,
  selectOpeningDefenseMove,
  selectModalOpeningMove,
  selectModalScoutMove,
  selectSafetyRankedMove,
  evaluatePosition,
  battleOutcomes,
  captureProbability,
  expectedCapturedStrength,
  DEFAULT_WEIGHTS,
  FAST_DEFAULTS,
  LEGACY_TUNED_RANKED_OPTIONS,
  C1_RANKED_OPTIONS,
  C4_RANKED_OPTIONS,
  DELAYED_MERGE_RANKED_OPTIONS,
  TUNED_RANKED_OPTIONS,
};
