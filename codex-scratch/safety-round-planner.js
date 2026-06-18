'use strict';

// Strict scratch experiment: keep the current defensive-opening + SafetyK2
// shape, but use a tiny one-round synthetic simulation to decide whether the
// next attack beats stopping. It never calls api.rng(), recovers seeds, mutates
// live nodes, or stores cross-game state.

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

function isOpeningState(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
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

function stateHash(state, salt = 0) {
  let h = (0x811C9DC5 ^ salt) >>> 0;
  for (const n of state.nodes) {
    const ownerIdx = FACTIONS.indexOf(n.owner) + 1;
    h ^= ((n.id + 1) * 97) ^ (ownerIdx * 193) ^ (n.strength * 8191);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function keyHash(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
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

function safetyMove(state, safetyOptions) {
  return codex.selectSafetyRankedMove(state, {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    minScore: 210,
    splitWeight: 25,
    ...safetyOptions,
  });
}

function rankedRestMove(state) {
  return codex.selectRankedMove(state, codex.DELAYED_MERGE_RANKED_OPTIONS);
}

function candidateActions(state, topK) {
  const actions = [{ stop: true, key: 'stop' }];
  const seen = new Set(['stop']);
  const options = { ...codex.FAST_DEFAULTS, ...codex.DELAYED_MERGE_RANKED_OPTIONS };
  for (const item of codex.rankedMoveScores(state, options).slice(0, topK)) {
    const key = `${item.move.from}:${item.move.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ move: item.move, key });
  }
  return actions;
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
  if (w) return w === HUMAN ? 1 : 0;

  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largestRed = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const redStrength = state.nodes
    .filter(n => n.owner === HUMAN)
    .reduce((sum, n) => sum + n.strength, 0);
  const strongestEnemy = BOTS.reduce((best, faction) => {
    const strength = state.nodes
      .filter(n => n.owner === faction)
      .reduce((sum, n) => sum + n.strength, 0);
    return Math.max(best, strength);
  }, 0);

  return Math.max(0, Math.min(1,
    0.50
    + (c.red - maxEnemy) / 30
    + (largestRed - 6) / 34
    + (redStrength - strongestEnemy) / 230
    - redRisk(state) / 45));
}

function makeSafetyRoundPlanner({
  samples = 2,
  topK = 2,
  maxAttacks = 80,
  maxRestAttacks = 20,
  attackMargin = 0.015,
  fallbackAfterRed = 15,
  safetyOptions = {},
  useSafetyRest = false,
} = {}) {
  let openingHandled = false;

  return function safetyRoundPlanner(api) {
    const opening = isOpeningState(cloneFromApi(api));
    if (opening) openingHandled = false;

    if (!openingHandled && opening) {
      openingHandled = true;
      for (let i = 0; i < 2; i++) {
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
      const c = counts(state);
      if (c.red >= WIN_NODES) return;

      if (c.red >= fallbackAfterRed) {
        const move = safetyMove(state, safetyOptions);
        if (!move) return;
        api.attack(move.from, move.to);
        continue;
      }

      const actions = candidateActions(state, topK);
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
              const next = useSafetyRest ? safetyMove(s, safetyOptions) : rankedRestMove(s);
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

const candidates = {
  safetyK2: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }),
  round2: () => makeSafetyRoundPlanner({ samples: 2, topK: 2, fallbackAfterRed: 15 }),
  round1: () => makeSafetyRoundPlanner({ samples: 1, topK: 2, fallbackAfterRed: 15 }),
  roundEarly: () => makeSafetyRoundPlanner({ samples: 2, topK: 2, fallbackAfterRed: 11, maxRestAttacks: 14 }),
  roundWide: () => makeSafetyRoundPlanner({ samples: 3, topK: 3, fallbackAfterRed: 15, maxRestAttacks: 18 }),
};

function main() {
  const games = Number(process.argv[2]) || 100;
  const seedBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!seedBases.length) seedBases.push(1, 1001, 10001);

  const rows = [];
  for (const [name, factory] of Object.entries(candidates)) {
    let total = 0;
    let totalMs = 0;
    const parts = [];
    for (const seedBase of seedBases) {
      const r = sim.scorePolicy(factory(), { games, seedBase });
      total += r.wins;
      totalMs += r.totalMs;
      parts.push(`${seedBase}:${r.wins}/${games}`);
    }
    rows.push({ name, total, parts, msPerGame: totalMs / (games * seedBases.length) });
  }

  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    console.log(`${row.name.padEnd(12)} ${String(row.total).padStart(4)}/${games * seedBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = { makeSafetyRoundPlanner };
