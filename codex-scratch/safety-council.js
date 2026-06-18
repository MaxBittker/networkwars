'use strict';

// Strict scratch experiment: use a small council of fixed ranked playbooks to
// propose attacks, then apply exact public-state safety expectation to only the
// council's top candidates. No api.rng(), seed recovery, live-node mutation, or
// cross-game memory.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');
const oracle = require('../codex-strategy/seed-oracle');

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

function moveKey(move) {
  return `${move.from}:${move.to}`;
}

function selectedPlaybooks() {
  const selected = [
    ['merge', codex.DELAYED_MERGE_RANKED_OPTIONS],
    ['c1', codex.C1_RANKED_OPTIONS],
    ['c4', codex.C4_RANKED_OPTIONS],
    ['legacy', codex.LEGACY_TUNED_RANKED_OPTIONS],
  ];

  const wanted = new Set([
    'rankedRand.35',
    'rankedRand.139',
    'rankedRand.187',
    'rankedRand.226',
    'targetRand.7.284',
    'targetRand.99.1',
    'targetRand.123456.217',
    'targetRand.314159.266',
  ]);

  for (const list of [oracle.GENERATED_RANKED_OPTIONS, oracle.TARGETED_RANKED_OPTIONS]) {
    for (const [name, options] of list) {
      if (wanted.has(name)) selected.push([name, options]);
    }
  }

  return selected;
}

const PLAYBOOKS = selectedPlaybooks();

function councilCandidates(state, {
  topPerBook = 2,
  candidateLimit = 4,
  useThreshold = true,
  voteWeight = 18,
  rankDecay = 0.35,
} = {}) {
  const byMove = new Map();

  for (const [, options] of PLAYBOOKS) {
    let added = 0;
    for (const item of codex.rankedMoveScores(state, options)) {
      if (added >= topPerBook) break;
      if (useThreshold && item.score < options.threshold) continue;

      const key = moveKey(item.move);
      const current = byMove.get(key) || {
        move: item.move,
        votes: 0,
        councilScore: 0,
        bestRankedScore: -Infinity,
      };
      const normalized = Math.max(0, item.score - options.threshold) / 100;
      current.votes++;
      current.councilScore += voteWeight / (1 + added * rankDecay) + normalized;
      current.bestRankedScore = Math.max(current.bestRankedScore, item.score);
      byMove.set(key, current);
      added++;
    }
  }

  return [...byMove.values()]
    .sort((a, b) => b.councilScore - a.councilScore || b.votes - a.votes)
    .slice(0, candidateLimit);
}

function selectCouncilSafetyMove(state, {
  topPerBook = 2,
  candidateLimit = 4,
  minScore = 210,
  minVotes = 1,
  councilWeight = 1,
  safetyWeight = 45,
  threatenedWeight = 16,
  countWeight = 4,
  redGainWeight = 28,
  largestWeight = 22,
  strengthWeight = 2,
  splitWeight = 25,
  enemyWeight = 18,
  useThreshold = true,
  voteWeight = 18,
} = {}) {
  const candidates = councilCandidates(state, {
    topPerBook,
    candidateLimit,
    useThreshold,
    voteWeight,
  }).filter(cand => cand.votes >= minVotes);

  let best = null;
  let bestScore = -Infinity;
  for (const cand of candidates) {
    const safety = expectedSafetyAfterMove(state, cand.move);
    const score =
      cand.bestRankedScore
      + cand.councilScore * councilWeight
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

function makeSafetyCouncil(options = {}) {
  const {
    maxOpeningAttacks = 2,
    maxAttacks = 120,
    ...moveOptions
  } = options;
  let openingHandled = false;

  return function safetyCouncil(api) {
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
      const move = selectCouncilSafetyMove(state, moveOptions);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

const candidateFactories = {
  safetyK2: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }),
  threat36: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, threatenedWeight: 36 }),
  councilA: () => makeSafetyCouncil({ topPerBook: 1, candidateLimit: 3, councilWeight: 0.8 }),
  councilB: () => makeSafetyCouncil({ topPerBook: 2, candidateLimit: 4, councilWeight: 1.0 }),
  councilC: () => makeSafetyCouncil({ topPerBook: 2, candidateLimit: 5, councilWeight: 1.4, minVotes: 2 }),
  councilLoose: () => makeSafetyCouncil({ topPerBook: 2, candidateLimit: 4, useThreshold: false, councilWeight: 0.6, voteWeight: 10 }),
  councilThreat: () => makeSafetyCouncil({ topPerBook: 2, candidateLimit: 4, councilWeight: 1.0, threatenedWeight: 36 }),
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
  makeSafetyCouncil,
  selectCouncilSafetyMove,
};
