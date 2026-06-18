'use strict';

// Strict scratch experiment: evaluate top ranked RED moves by exact public
// battle outcomes plus one bounded "first strike" pass through the bots after
// RED reinforcement. This models turn order without api.rng(), seed recovery,
// live-node mutation, benchmark-order state, or full rollout search.

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
  for (const f of FACTIONS) if (c[f] >= WIN_NODES) return f;
  const alive = FACTIONS.filter(f => c[f] > 0);
  return alive.length === 1 ? alive[0] : null;
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

function redRisk(state) {
  let risk = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner === HUMAN && n.strength > target.strength) {
        risk += codex.captureProbability(n.strength, target.strength);
      }
    }
  }
  return risk;
}

function boardValue(state) {
  const w = winner(state);
  if (w) return w === HUMAN ? 100000 : -100000;

  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redStrength = state.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const strongestEnemy = BOTS.reduce((best, faction) => {
    const strength = state.nodes
      .filter(n => n.owner === faction)
      .reduce((sum, n) => sum + n.strength, 0);
    return Math.max(best, strength);
  }, 0);

  return c.red * 170
    + largest * 130
    + redStrength * 5
    - maxEnemy * 50
    - strongestEnemy * 2
    - Math.max(0, redComps.length - 1) * 30
    - redRisk(state) * 75;
}

function trimBeam(beam, limit) {
  if (beam.length <= limit) return beam;
  beam.sort((a, b) => (b.prob * boardValue(b.state)) - (a.prob * boardValue(a.state)));
  return beam.slice(0, limit);
}

function expectedFirstStrikeValue(afterRedState, beamLimit = 18, outcomeProbFloor = 0.002) {
  let beam = [{ prob: 1, state: afterRedState }];

  for (const bot of BOTS) {
    const nextBeam = [];
    for (const branch of beam) {
      if (winner(branch.state) || counts(branch.state)[bot] === 0) {
        nextBeam.push(branch);
        continue;
      }

      const move = bestBotMove(branch.state, bot);
      if (!move) {
        nextBeam.push(branch);
        continue;
      }

      const from = branch.state.nodes[move.from];
      const to = branch.state.nodes[move.to];
      for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
        const prob = branch.prob * outcome.prob;
        if (prob < outcomeProbFloor) continue;
        nextBeam.push({ prob, state: applyOutcome(branch.state, move, outcome) });
      }
    }

    const kept = trimBeam(nextBeam, beamLimit);
    const keptProb = kept.reduce((sum, item) => sum + item.prob, 0);
    if (keptProb > 0 && keptProb < 0.999) {
      for (const item of kept) item.prob /= keptProb;
    }
    beam = kept;
  }

  return beam.reduce((sum, branch) => sum + branch.prob * boardValue(branch.state), 0);
}

function firstStrikeDelta(state, move, beamLimit) {
  const base = cloneState(state);
  reinforce(base, HUMAN);
  const baseValue = expectedFirstStrikeValue(base, beamLimit);

  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  let expected = 0;
  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    reinforce(next, HUMAN);
    expected += outcome.prob * expectedFirstStrikeValue(next, beamLimit);
  }
  return expected - baseValue;
}

function selectFirstStrikeMove(state, {
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  topK = 2,
  minScore = 210,
  strikeWeight = 0.45,
  beamLimit = 18,
  safetyOptions = {},
} = {}) {
  const options = { ...codex.FAST_DEFAULTS, ...rankedOptions };
  const ranked = codex.rankedMoveScores(state, options).slice(0, topK);
  if (!ranked.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const item of ranked) {
    const safetyMove = codex.selectSafetyRankedMove(state, {
      rankedOptions,
      minScore,
      topK,
      ...safetyOptions,
    });
    const safetyBonus = safetyMove && safetyMove.from === item.move.from && safetyMove.to === item.move.to ? 25 : 0;
    const score = item.score + firstStrikeDelta(state, item.move, beamLimit) * strikeWeight + safetyBonus;
    if (score > bestScore) {
      best = item.move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function makeFirstStrikeSafety({
  maxOpeningAttacks = 2,
  maxAttacks = 120,
  ...moveOptions
} = {}) {
  let openingHandled = false;

  return function firstStrikeSafety(api) {
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
      const move = selectFirstStrikeMove(state, moveOptions);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

const candidateFactories = {
  safetyK2: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }),
  threat36: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, threatenedWeight: 36 }),
  strikeA: () => makeFirstStrikeSafety({ topK: 2, strikeWeight: 0.35, beamLimit: 12 }),
  strikeB: () => makeFirstStrikeSafety({ topK: 2, strikeWeight: 0.50, beamLimit: 12 }),
  strikeC: () => makeFirstStrikeSafety({ topK: 2, strikeWeight: 0.30, beamLimit: 8, minScore: 220 }),
  strikeThreat: () => makeFirstStrikeSafety({
    topK: 2,
    strikeWeight: 0.35,
    beamLimit: 12,
    safetyOptions: { threatenedWeight: 36, splitWeight: 25 },
  }),
};

function main() {
  const games = Number(process.argv[2]) || 60;
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
    console.log(`${row.name.padEnd(12)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeFirstStrikeSafety,
  selectFirstStrikeMove,
  expectedFirstStrikeValue,
};
