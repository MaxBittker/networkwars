'use strict';

// Strict scratch experiment: after the validated defensive opening, choose among
// the top ranked moves using exact expectation over the visible first bot target
// choices after RED reinforcement. This models bot targeting more directly than
// the broader all-threat safety penalty.

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

function safetyStatsAfterRedReinforcement(state) {
  const s = cloneState(state);
  reinforce(s, HUMAN);

  let allRisk = 0;
  let allCount = 0;
  let botRedRisk = 0;
  let botRedCount = 0;
  let botRedStrengthRisk = 0;
  let botAnyRedAdjacent = 0;
  const threatenedRed = new Set();

  for (const n of s.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of s.adj[n.id]) {
      const target = s.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      allRisk += p;
      allCount++;
      if (p > 0.45) threatenedRed.add(to);
    }
  }

  for (const bot of BOTS) {
    const move = bestBotMove(s, bot);
    if (!move) continue;
    if (s.nodes[move.to].owner === HUMAN) {
      const p = codex.captureProbability(s.nodes[move.from].strength, s.nodes[move.to].strength);
      botRedRisk += p;
      botRedCount++;
      botRedStrengthRisk += p * s.nodes[move.to].strength;
    }
    if (s.adj[move.from].some(nb => s.nodes[nb].owner === HUMAN)) botAnyRedAdjacent++;
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
    allCount,
    botRedRisk,
    botRedCount,
    botRedStrengthRisk,
    botAnyRedAdjacent,
    threatened: threatenedRed.size,
    red: c.red,
    maxEnemy,
    largest,
    redStrength,
    splits: Math.max(0, redComps.length - 1),
  };
}

function expectedStatsAfterMove(state, move) {
  const from = state.nodes[move.from];
  const to = state.nodes[move.to];
  const current = safetyStatsAfterRedReinforcement(state);
  const out = Object.fromEntries([
    'allRiskDrop',
    'allCountDrop',
    'botRiskDrop',
    'botCountDrop',
    'botStrengthDrop',
    'botAdjDrop',
    'threatenedDrop',
    'redGain',
    'largestGain',
    'strengthGain',
    'splitDrop',
    'maxEnemyDrop',
  ].map(k => [k, 0]));

  for (const outcome of codex.battleOutcomes(from.strength, to.strength)) {
    const next = applyOutcome(state, move, outcome);
    const s = safetyStatsAfterRedReinforcement(next);
    out.allRiskDrop += outcome.prob * (current.allRisk - s.allRisk);
    out.allCountDrop += outcome.prob * (current.allCount - s.allCount);
    out.botRiskDrop += outcome.prob * (current.botRedRisk - s.botRedRisk);
    out.botCountDrop += outcome.prob * (current.botRedCount - s.botRedCount);
    out.botStrengthDrop += outcome.prob * (current.botRedStrengthRisk - s.botRedStrengthRisk);
    out.botAdjDrop += outcome.prob * (current.botAnyRedAdjacent - s.botAnyRedAdjacent);
    out.threatenedDrop += outcome.prob * (current.threatened - s.threatened);
    out.redGain += outcome.prob * (s.red - current.red);
    out.largestGain += outcome.prob * (s.largest - current.largest);
    out.strengthGain += outcome.prob * (s.redStrength - current.redStrength);
    out.splitDrop += outcome.prob * (current.splits - s.splits);
    out.maxEnemyDrop += outcome.prob * (current.maxEnemy - s.maxEnemy);
  }

  return out;
}

function selectBotChoiceMove(state, {
  rankedOptions = codex.DELAYED_MERGE_RANKED_OPTIONS,
  topK = 2,
  minScore = 210,
  allRiskWeight = 20,
  botRiskWeight = 70,
  botCountWeight = 18,
  botStrengthWeight = 10,
  threatenedWeight = 12,
  redGainWeight = 24,
  largestWeight = 22,
  strengthWeight = 2,
  splitWeight = 35,
  enemyWeight = 18,
} = {}) {
  const options = { ...codex.FAST_DEFAULTS, ...rankedOptions };
  const ranked = codex.rankedMoveScores(state, options).slice(0, topK);
  if (!ranked.length) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const item of ranked) {
    const s = expectedStatsAfterMove(state, item.move);
    const score =
      item.score
      + s.allRiskDrop * allRiskWeight
      + s.botRiskDrop * botRiskWeight
      + s.botCountDrop * botCountWeight
      + s.botStrengthDrop * botStrengthWeight
      + s.threatenedDrop * threatenedWeight
      + s.redGain * redGainWeight
      + s.largestGain * largestWeight
      + s.strengthGain * strengthWeight
      + s.splitDrop * splitWeight
      + s.maxEnemyDrop * enemyWeight;
    if (score > bestScore) {
      best = item.move;
      bestScore = score;
    }
  }

  return best && bestScore >= minScore ? best : null;
}

function makeBotChoiceSafety(options = {}) {
  let openingHandled = false;

  return function botChoiceSafety(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
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

    for (let attacks = 0; attacks < 120; attacks++) {
      const state = cloneFromApi(api);
      const c = counts(state);
      if (c.red >= WIN_NODES) return;
      const moveOptions = { ...options };
      if (options.dynamicThreat) {
        const maxEnemy = Math.max(...BOTS.map(f => c[f]));
        moveOptions.threatenedWeight = maxEnemy - c.red >= (options.gapCut ?? 2)
          ? (options.highThreatenedWeight ?? 36)
          : (options.lowThreatenedWeight ?? 16);
      }
      const move = selectBotChoiceMove(state, moveOptions);
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function main() {
  const games = Number(process.argv[2]) || 180;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 2001, 10001, 50001);

  const candidates = [
    ['safetyK2', () => codex.makeSafetyK2Strategy({ minScore: 210 })],
  ];
  for (const botRiskWeight of [30, 50, 70, 100]) {
    for (const allRiskWeight of [0, 10, 20, 35]) {
      candidates.push([`b${botRiskWeight}/a${allRiskWeight}`, () => makeBotChoiceSafety({
        botRiskWeight,
        allRiskWeight,
      })]);
    }
  }
  for (const botStrengthWeight of [0, 6, 14, 24]) {
    candidates.push([`strength${botStrengthWeight}`, () => makeBotChoiceSafety({
      botRiskWeight: 70,
      allRiskWeight: 20,
      botStrengthWeight,
    })]);
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
    console.log(`${row.name.padEnd(16)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeBotChoiceSafety,
  selectBotChoiceMove,
};
