'use strict';

// Strict scratch experiment: after the validated defensive opening, choose among
// only the top few ranked moves using exact visible-state safety expectation.
// No api.rng(), no seed recovery, no live-node mutation.

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

function components(state, faction = HUMAN) {
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

function reinforce(state, faction = HUMAN) {
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

function applyOutcome(state, move, outcome) {
  const next = cloneState(state);
  const from = next.nodes[move.from];
  const to = next.nodes[move.to];
  from.strength = outcome.fromStrength;
  if (outcome.captured) to.owner = from.owner;
  to.strength = outcome.toStrength;
  return next;
}

function threatAfterRedReinforcement(state) {
  const s = cloneState(state);
  reinforce(s, HUMAN);

  let allRisk = 0;
  let beatableRed = 0;
  let maxP = 0;
  const redThreatened = new Set();
  for (const n of s.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of s.adj[n.id]) {
      const target = s.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      allRisk += p;
      beatableRed++;
      maxP = Math.max(maxP, p);
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
    maxP,
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
  const current = threatAfterRedReinforcement(state);
  const out = {
    captureP: 0,
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
    const s = threatAfterRedReinforcement(next);
    if (outcome.captured) out.captureP += outcome.prob;
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

function selectSafetyMove(state, {
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  topK = 4,
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
  const options = { ...codex.FAST_DEFAULTS, ...rankedOptions };
  const ranked = codex.rankedMoveScores(state, options).slice(0, topK);
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

function makeSafetyRanked({
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  maxAttacks = 120,
  ...safetyOptions
} = {}) {
  let openingHandled = false;

  return function safetyRanked(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < 2; i++) {
        const state = cloneFromApi(api);
        const move = codex.selectOpeningDefenseMove(state, {
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
      const move = selectSafetyMove(state, { rankedOptions, ...safetyOptions });
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function main() {
  const games = Number(process.argv[2]) || 160;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 2001, 10001, 50001);

  const candidates = [
    ['openingDefense', () => codex.makeOpeningDefenseDelayStrategy()],
  ];
  for (const topK of [2, 3, 4, 5]) {
    for (const safetyWeight of [15, 30, 45, 65]) {
      for (const redGainWeight of [16, 28, 42]) {
        const name = `k${topK}/s${safetyWeight}/r${redGainWeight}`;
        candidates.push([name, () => makeSafetyRanked({ topK, safetyWeight, redGainWeight })]);
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
  for (const row of rows.slice(0, 30)) {
    console.log(`${row.name.padEnd(18)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeSafetyRanked,
  selectSafetyMove,
};

