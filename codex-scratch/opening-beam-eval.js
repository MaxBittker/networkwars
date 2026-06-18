'use strict';

// Strict scratch experiment: use exact public battle outcome probabilities with
// beam pruning to evaluate only the opening turn through the first bot round.
// It does not call api.rng(), recover seeds, mutate live nodes, memorize boards,
// or use benchmark-order state.

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

function stateKey(state) {
  return state.nodes.map(n => `${n.owner[0]}${n.strength}`).join('|');
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
  if (w) return w === HUMAN ? 1000 : -1000;

  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largestRed = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const redStrength = state.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const maxEnemyStrength = BOTS.reduce((best, faction) => Math.max(best, state.nodes
    .filter(n => n.owner === faction)
    .reduce((sum, n) => sum + n.strength, 0)), 0);

  return c.red * 95
    + largestRed * 75
    + redStrength * 4
    - maxEnemy * 55
    - maxEnemyStrength * 1.5
    - Math.max(0, redComps.length - 1) * 40
    - redRisk(state) * 80;
}

function mergeAndPrune(weightedStates, beam) {
  const merged = new Map();
  for (const item of weightedStates) {
    const key = stateKey(item.state);
    const existing = merged.get(key);
    if (existing) existing.prob += item.prob;
    else merged.set(key, { prob: item.prob, state: item.state });
  }
  return [...merged.values()]
    .sort((a, b) => (b.prob * Math.max(1, boardValue(b.state) + 1200))
      - (a.prob * Math.max(1, boardValue(a.state) + 1200)))
    .slice(0, beam);
}

function expandBattle(item, move) {
  const from = item.state.nodes[move.from];
  const to = item.state.nodes[move.to];
  return codex.battleOutcomes(from.strength, to.strength).map(outcome => ({
    prob: item.prob * outcome.prob,
    state: applyOutcome(item.state, move, outcome),
  }));
}

function runBotTurnBeam(states, faction, beam) {
  let frontier = states;
  for (let guard = 0; guard < 80; guard++) {
    const expanded = [];
    let anyMove = false;
    for (const item of frontier) {
      if (winner(item.state) || counts(item.state)[faction] === 0) {
        expanded.push(item);
        continue;
      }
      const move = bestBotMove(item.state, faction);
      if (!move) {
        const s = cloneState(item.state);
        reinforce(s, faction);
        expanded.push({ prob: item.prob, state: s });
        continue;
      }
      anyMove = true;
      expanded.push(...expandBattle(item, move));
    }
    frontier = mergeAndPrune(expanded, beam);
    if (!anyMove) return frontier;
  }
  return frontier;
}

function finishRoundBeam(state, { beam = 48 } = {}) {
  const redReinforced = cloneState(state);
  reinforce(redReinforced, HUMAN);
  let frontier = [{ prob: 1, state: redReinforced }];
  for (const bot of BOTS) {
    frontier = runBotTurnBeam(frontier, bot, beam);
  }
  return frontier.reduce((sum, item) => sum + item.prob * boardValue(item.state), 0);
}

function openingCandidates(state, limit, minP) {
  const ranked = new Map();
  for (const item of codex.rankedMoveScores(state, codex.DELAYED_MERGE_RANKED_OPTIONS)) {
    ranked.set(`${item.move.from}:${item.move.to}`, item.score);
  }
  return legalMoves(state)
    .map(move => {
      const from = state.nodes[move.from];
      const to = state.nodes[move.to];
      const p = codex.captureProbability(from.strength, to.strength);
      let score = p * 90
        + (ranked.get(`${move.from}:${move.to}`) || 0) * 0.05
        + (from.strength - to.strength) * 7
        + (to.strength <= 2 ? 12 : 0);
      for (const nb of state.adj[to.id]) {
        if (state.nodes[nb].owner === HUMAN) score += 10;
      }
      return { move, p, score };
    })
    .filter(item => item.p >= minP)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.move);
}

function expectedAfterMove(state, move, remaining, options, memo) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  let total = 0;
  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    total += outcome.prob * openingValue(next, remaining, options, memo);
  }
  return total;
}

function openingValue(state, remaining, options, memo) {
  const key = `${remaining}:${stateKey(state)}`;
  if (memo.has(key)) return memo.get(key);
  const stopValue = finishRoundBeam(state, options);
  if (remaining <= 0) {
    memo.set(key, stopValue);
    return stopValue;
  }

  let best = stopValue;
  for (const move of openingCandidates(state, options.candidateLimit, options.minP)) {
    const value = expectedAfterMove(state, move, remaining - 1, options, memo);
    if (value > best) best = value;
  }
  memo.set(key, best);
  return best;
}

function selectOpeningBeamMove(state, options = {}) {
  const opts = {
    beam: 48,
    candidateLimit: 5,
    minP: 0.5,
    margin: 4,
    remaining: 2,
    ...options,
  };
  const memo = new Map();
  const stopValue = finishRoundBeam(state, opts);
  let best = null;
  let bestValue = stopValue;
  for (const move of openingCandidates(state, opts.candidateLimit, opts.minP)) {
    const value = expectedAfterMove(state, move, opts.remaining - 1, opts, memo);
    if (value > bestValue) {
      best = move;
      bestValue = value;
    }
  }
  return best && bestValue >= stopValue + opts.margin ? best : null;
}

function safetyMove(state, options = {}) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  return codex.selectSafetyRankedMove(state, {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    topK: 6,
    minScore: 210,
    countWeight: 14,
    splitWeight: 25,
    threatenedWeight: maxEnemy - c.red >= 2 ? 36 : 16,
    ...options,
  });
}

function makeOpeningBeamStrategy({
  maxOpeningAttacks = 2,
  openingOptions = {},
  safetyOptions = {},
} = {}) {
  let openingHandled = false;

  return function openingBeamStrategy(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < maxOpeningAttacks; i++) {
        const state = cloneFromApi(api);
        const move = selectOpeningBeamMove(state, {
          remaining: maxOpeningAttacks - i,
          ...openingOptions,
        });
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < 120; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = safetyMove(state, safetyOptions);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function main() {
  const games = Number(process.argv[2]) || 40;
  const args = process.argv.slice(3);
  const namesArg = args.find(arg => arg.startsWith('names='));
  const names = new Set(namesArg
    ? namesArg.slice('names='.length).split(',').map(name => name.trim()).filter(Boolean)
    : []);
  const bases = args
    .filter(arg => !arg.startsWith('names='))
    .map(Number)
    .filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 10001);

  const candidates = {
    modal: () => codex.codexModalOpeningGap,
    current: () => codex.codexSafetyGap2Threat,
    beamOneTiny: () => makeOpeningBeamStrategy({
      maxOpeningAttacks: 1,
      openingOptions: { beam: 6, candidateLimit: 2, minP: 0.55, margin: 5, remaining: 1 },
    }),
    beamOneSmall: () => makeOpeningBeamStrategy({
      maxOpeningAttacks: 1,
      openingOptions: { beam: 10, candidateLimit: 3, minP: 0.5, margin: 4, remaining: 1 },
    }),
    beamStepTiny: () => makeOpeningBeamStrategy({
      openingOptions: { beam: 6, candidateLimit: 2, minP: 0.55, margin: 5, remaining: 1 },
    }),
    beamStepSmall: () => makeOpeningBeamStrategy({
      openingOptions: { beam: 10, candidateLimit: 3, minP: 0.5, margin: 4, remaining: 1 },
    }),
    beamTiny: () => makeOpeningBeamStrategy({
      openingOptions: { beam: 12, candidateLimit: 3, minP: 0.55, margin: 6 },
    }),
    beamSmall: () => makeOpeningBeamStrategy({
      openingOptions: { beam: 20, candidateLimit: 4, minP: 0.5, margin: 5 },
    }),
    beamWide: () => makeOpeningBeamStrategy({
      openingOptions: { beam: 48, candidateLimit: 5, minP: 0.45, margin: 4 },
    }),
    beamStrict: () => makeOpeningBeamStrategy({
      openingOptions: { beam: 48, candidateLimit: 5, minP: 0.55, margin: 8 },
    }),
  };

  const rows = [];
  for (const [name, factory] of Object.entries(candidates)) {
    if (names.size && !names.has(name)) continue;
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
  makeOpeningBeamStrategy,
  selectOpeningBeamMove,
};
