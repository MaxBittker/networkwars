'use strict';

// Strict scratch planner: no api.rng(), no seed recovery, no live-node mutation.
// It samples possible future battles with a deterministic PRNG derived from the
// visible board only, then executes legal api.attack(...) moves.

const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';
const WIN_NODES = 24;
const ATTACKER_WIN_P = 0.55;

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

function stateHash(state, salt = 0) {
  let h = (0x811C9DC5 ^ salt) >>> 0;
  for (const n of state.nodes) {
    const ownerIdx = FACTIONS.indexOf(n.owner) + 1;
    h ^= ((n.id + 1) * 97) ^ (ownerIdx * 193) ^ (n.strength * 8191);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  } else {
    to.strength = d;
  }
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
  for (let guard = 0; guard < 1000; guard++) {
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

function openingOkCount(state) {
  let ok = 0;
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    if (codex.captureProbability(from.strength, to.strength) > 0.4) ok++;
  }
  return ok;
}

function isOpeningState(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function pressureOptionsFor(state, mode) {
  const selected = mode === 'high' ? codex.C1_RANKED_OPTIONS : codex.C4_RANKED_OPTIONS;
  return { ...codex.FAST_DEFAULTS, ...selected };
}

function selectPressureMove(state, mode, { leaderBonus = 13, endDrop = 14 } = {}) {
  const options = pressureOptionsFor(state, mode);
  const c = counts(state);
  if (c.red >= WIN_NODES) return null;
  const enemyCounts = BOTS.map(f => c[f]).sort((a, b) => b - a);
  const maxEnemy = enemyCounts[0];
  const secondEnemy = enemyCounts[1];
  const threshold = options.threshold - Math.max(0, c.red - 14) * endDrop;

  let best = null;
  let bestScore = -Infinity;
  for (const item of codex.rankedMoveScores(state, options)) {
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
  return best && bestScore >= threshold ? best : null;
}

function playoutRedTurn(state, rng, mode, maxAttacks = 80) {
  for (let guard = 0; guard < maxAttacks && !winner(state); guard++) {
    const move = selectPressureMove(state, mode);
    if (!move) return;
    resolveBattleSample(state, move, rng);
  }
}

function playoutValue(state, rng, mode, horizonTurns) {
  for (let t = 0; t < horizonTurns; t++) {
    const w = winner(state);
    if (w) return w === HUMAN ? 1 : 0;
    playoutRedTurn(state, rng, mode);
    if (winner(state)) break;
    finishRoundSample(state, rng);
  }

  const w = winner(state);
  if (w) return w === HUMAN ? 1 : 0;

  const c = counts(state);
  const largestRed = components(state, HUMAN)
    .reduce((best, comp) => Math.max(best, comp.length), 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const redStrength = state.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const enemyStrength = state.nodes
    .filter(n => n.owner !== HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);

  return Math.max(0, Math.min(1,
    0.48
    + (c.red - maxEnemy) / 32
    + (largestRed - 6) / 35
    + (redStrength - enemyStrength / 4) / 180));
}

function candidateActions(state, mode, topK) {
  const seen = new Set(['stop']);
  const actions = [{ stop: true, key: 'stop' }];
  const optionSets = [
    pressureOptionsFor(state, mode),
    { ...codex.FAST_DEFAULTS, ...codex.C1_RANKED_OPTIONS },
    { ...codex.FAST_DEFAULTS, ...codex.C4_RANKED_OPTIONS },
    { ...codex.FAST_DEFAULTS, ...codex.LEGACY_TUNED_RANKED_OPTIONS },
  ];

  for (const options of optionSets) {
    for (const item of codex.rankedMoveScores(state, options).slice(0, topK)) {
      const key = `${item.move.from}:${item.move.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push({ move: item.move, key });
    }
  }

  return actions;
}

function keyHash(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function boardValue(state) {
  const w = winner(state);
  if (w) return w === HUMAN ? 1 : 0;

  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largestRed = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const redStrength = state.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const strongestEnemy = BOTS.reduce((best, faction) => {
    const str = state.nodes
      .filter(n => n.owner === faction)
      .reduce((sum, n) => sum + n.strength, 0);
    return Math.max(best, str);
  }, 0);

  return Math.max(0, Math.min(1,
    0.48
    + (c.red - maxEnemy) / 28
    + (largestRed - 6) / 34
    + (redStrength - strongestEnemy) / 220));
}

function makeRoundPlanner({
  samples = 4,
  topK = 2,
  maxActions = 7,
  maxAttacks = 55,
  maxRestAttacks = 35,
  attackMargin = 0.015,
  fallbackAfterRed = 16,
} = {}) {
  let mode = null;

  return function roundPlanner(api) {
    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (mode === null || isOpeningState(state)) {
        mode = openingOkCount(state) >= 13 ? 'high' : 'fallback';
      }

      const c = counts(state);
      if (c.red >= WIN_NODES) return;
      if (c.red >= fallbackAfterRed) {
        const move = selectPressureMove(state, mode, { leaderBonus: 13, endDrop: 14 });
        if (!move) return;
        api.attack(move.from, move.to);
        continue;
      }

      const actions = candidateActions(state, mode, topK).slice(0, maxActions);
      if (actions.length <= 1) return;

      let bestAction = actions[0];
      let bestValue = -Infinity;
      let stopValue = -Infinity;

      for (const action of actions) {
        let total = 0;
        for (let i = 0; i < samples; i++) {
          const s = cloneState(state);
          const salt = (i + 1) * 1543 + keyHash(action.key) + attacks * 7919;
          const rng = makeRng(stateHash(state, salt));

          if (action.move) {
            resolveBattleSample(s, action.move, rng);
            for (let rest = 0; rest < maxRestAttacks && !winner(s); rest++) {
              const next = selectPressureMove(s, mode, { leaderBonus: 13, endDrop: 14 });
              if (!next) break;
              resolveBattleSample(s, next, rng);
            }
          }

          if (!winner(s)) finishRoundSample(s, rng);
          total += boardValue(s);
        }

        const value = total / samples;
        if (action.stop) stopValue = value;
        if (value > bestValue) {
          bestAction = action;
          bestValue = value;
        }
      }

      if (!bestAction.move || bestValue <= stopValue + attackMargin) return;
      api.attack(bestAction.move.from, bestAction.move.to);
    }
  };
}

function makeRolloutPlanner({
  rollouts = 6,
  horizonTurns = 9,
  topK = 2,
  maxActions = 8,
  maxAttacks = 35,
  attackMargin = 0.025,
  fallbackAfterRed = 14,
} = {}) {
  let mode = null;

  return function rolloutPlanner(api) {
    for (let attacks = 0; attacks < maxAttacks; attacks++) {
      const state = cloneFromApi(api);
      if (mode === null || isOpeningState(state)) {
        mode = openingOkCount(state) >= 13 ? 'high' : 'fallback';
      }

      const c = counts(state);
      if (c.red >= WIN_NODES) return;
      if (c.red >= fallbackAfterRed) {
        const move = selectPressureMove(state, mode, { leaderBonus: 13, endDrop: 14 });
        if (!move) return;
        api.attack(move.from, move.to);
        continue;
      }

      const actions = candidateActions(state, mode, topK).slice(0, maxActions);
      if (actions.length <= 1) return;

      let bestAction = actions[0];
      let bestValue = -Infinity;
      let stopValue = -Infinity;
      for (const action of actions) {
        let total = 0;
        for (let i = 0; i < rollouts; i++) {
          const s = cloneState(state);
          const salt = (i + 1) * 1009 + action.key.length * 917 + attacks * 7919;
          const rng = makeRng(stateHash(state, salt));
          if (action.move) {
            resolveBattleSample(s, action.move, rng);
            if (!winner(s)) playoutRedTurn(s, rng, mode);
            if (!winner(s)) finishRoundSample(s, rng);
          } else {
            finishRoundSample(s, rng);
          }
          total += playoutValue(s, rng, mode, horizonTurns);
        }

        const value = total / rollouts;
        if (action.stop) stopValue = value;
        if (value > bestValue) {
          bestValue = value;
          bestAction = action;
        }
      }

      if (!bestAction.move || bestValue <= stopValue + attackMargin) return;
      api.attack(bestAction.move.from, bestAction.move.to);
    }
  };
}

const candidates = {
  pressure: codex.makePressureStrategy(),
  roundTiny: makeRoundPlanner({ samples: 2, topK: 1, maxActions: 4, fallbackAfterRed: 12 }),
  roundSmall: makeRoundPlanner({ samples: 3, topK: 2, maxActions: 6, fallbackAfterRed: 14 }),
  roundWide: makeRoundPlanner({ samples: 4, topK: 2, maxActions: 8, fallbackAfterRed: 16 }),
};

function main() {
  const games = Number(process.argv[2]) || 80;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const rows = [];
  for (const [name, policy] of Object.entries(candidates)) {
    let total = 0;
    const parts = [];
    let totalMs = 0;
    for (const seedBase of seedBases) {
      const r = sim.scorePolicy(policy, { games, seedBase });
      total += r.wins;
      totalMs += r.totalMs;
      parts.push(`${seedBase}:${r.wins}/${games}`);
    }
    rows.push({ name, total, parts, msPerGame: totalMs / (games * seedBases.length) });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    console.log(`${row.name.padEnd(14)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeRolloutPlanner, makeRoundPlanner };
