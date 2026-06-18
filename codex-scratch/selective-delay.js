'use strict';

// Strict experiment: use the delayed-merge playbook, but skip the opening turn
// only when the visible first bot round does not look too dangerous for RED.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';

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

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function allBotRedThreat(state) {
  let count = 0;
  let risk = 0;
  let maxP = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      count++;
      risk += p;
      maxP = Math.max(maxP, p);
    }
  }
  return { count, risk, maxP };
}

function bestBotRedThreat(state) {
  const s = cloneState(state);
  G.reinforce(s, HUMAN);

  let count = 0;
  let risk = 0;
  let maxP = 0;
  for (const bot of BOTS) {
    const move = G.bestBotMove(s, bot);
    if (!move || s.nodes[move.to].owner !== HUMAN) continue;
    const p = codex.captureProbability(s.nodes[move.from].strength, s.nodes[move.to].strength);
    count++;
    risk += p;
    maxP = Math.max(maxP, p);
  }

  const all = allBotRedThreat(s);
  return { count, risk, maxP, allCount: all.count, allRisk: all.risk, allMaxP: all.maxP };
}

function makeSelectiveDelay({
  options = codex.DELAYED_MERGE_RANKED_OPTIONS,
  waitTurns = 1,
  chooser,
} = {}) {
  const policy = codex.makeRankedStrategy(options);
  let waitsRemaining = 0;

  return function selectiveDelay(api) {
    const state = cloneFromApi(api);
    if (isOpening(state)) {
      waitsRemaining = chooser(state) ? waitTurns : 0;
    }

    if (waitsRemaining > 0) {
      waitsRemaining--;
      return;
    }

    return policy(api);
  };
}

function scoreCandidate(name, factory, games, bases) {
  let total = 0;
  let totalMs = 0;
  const parts = [];
  for (const seedBase of bases) {
    const r = sim.scorePolicy(factory(), { games, seedBase });
    total += r.wins;
    totalMs += r.totalMs;
    parts.push(`${seedBase}:${r.wins}/${games}`);
  }
  return { name, total, parts, msPerGame: totalMs / (games * bases.length) };
}

function main() {
  const games = Number(process.argv[2]) || 250;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 2001, 10001, 50001);

  const candidates = [
    ['alwaysWait', () => codex.makeDelayedRankedStrategy(codex.DELAYED_MERGE_RANKED_OPTIONS)],
    ['neverWait', () => codex.makeRankedStrategy(codex.DELAYED_MERGE_RANKED_OPTIONS)],
  ];

  for (const maxRisk of [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 3.0]) {
    candidates.push([`bestRisk<=${maxRisk}`, () => makeSelectiveDelay({
      chooser(state) {
        return bestBotRedThreat(state).risk <= maxRisk;
      },
    })]);
  }

  for (const maxCount of [0, 1, 2, 3, 4]) {
    candidates.push([`bestCount<=${maxCount}`, () => makeSelectiveDelay({
      chooser(state) {
        return bestBotRedThreat(state).count <= maxCount;
      },
    })]);
  }

  for (const maxAllRisk of [1, 2, 3, 4, 5, 6, 7, 8]) {
    candidates.push([`allRisk<=${maxAllRisk}`, () => makeSelectiveDelay({
      chooser(state) {
        return bestBotRedThreat(state).allRisk <= maxAllRisk;
      },
    })]);
  }

  for (const maxAllCount of [3, 5, 7, 9, 11, 13, 15]) {
    candidates.push([`allCount<=${maxAllCount}`, () => makeSelectiveDelay({
      chooser(state) {
        return bestBotRedThreat(state).allCount <= maxAllCount;
      },
    })]);
  }

  const rows = candidates.map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total);
  for (const row of rows) {
    console.log(`${row.name.padEnd(18)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makeSelectiveDelay,
  bestBotRedThreat,
};

