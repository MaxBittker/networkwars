'use strict';

// Strict experiment: always skip RED's first turn, then choose one fixed ranked
// playbook for the rest of the game based on the visible post-wait board.

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

function counts(state) {
  const out = Object.fromEntries(FACTIONS.map(f => [f, 0]));
  for (const n of state.nodes) out[n.owner]++;
  return out;
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

function goodMoveCount(state) {
  let out = 0;
  for (const move of legalMoves(state)) {
    if (codex.captureProbability(state.nodes[move.from].strength, state.nodes[move.to].strength) > 0.4) {
      out++;
    }
  }
  return out;
}

function isOpening(state) {
  const c = counts(state);
  return FACTIONS.every(f => c[f] === 6)
    && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
}

function playRankedTurn(api, options, maxAttacks = 120) {
  const opts = { ...codex.FAST_DEFAULTS, ...options };
  for (let attacks = 0; attacks < maxAttacks; attacks++) {
    const state = cloneFromApi(api);
    if (counts(state).red >= WIN_NODES) return;
    const move = codex.selectRankedMove(state, opts);
    if (!move) return;
    api.attack(move.from, move.to);
  }
}

function makePostWaitSelector({
  normal = codex.DELAYED_MERGE_RANKED_OPTIONS,
  rescue = codex.C1_RANKED_OPTIONS,
  cut = 3,
  feature = 'red',
} = {}) {
  let waitsRemaining = 0;
  let selected = null;

  return function postWaitSelector(api) {
    const state = cloneFromApi(api);
    if (isOpening(state)) {
      waitsRemaining = 1;
      selected = null;
    }

    if (waitsRemaining > 0) {
      waitsRemaining--;
      return;
    }

    if (!selected) {
      const c = counts(state);
      const enemyCounts = BOTS.map(f => c[f]);
      const leaderGap = Math.max(...enemyCounts) - c.red;
      const good = goodMoveCount(state);
      const useRescue =
        (feature === 'red' && c.red <= cut)
        || (feature === 'gap' && leaderGap >= cut)
        || (feature === 'good' && good <= cut);
      selected = useRescue ? rescue : normal;
    }

    playRankedTurn(api, selected);
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

function optionCatalog() {
  const out = [
    ['merge', codex.DELAYED_MERGE_RANKED_OPTIONS],
    ['c1', codex.C1_RANKED_OPTIONS],
    ['c4', codex.C4_RANKED_OPTIONS],
    ['legacy', codex.LEGACY_TUNED_RANKED_OPTIONS],
    ['fast', codex.FAST_DEFAULTS],
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
      if (wanted.has(name)) out.push([name, options]);
    }
  }
  return out;
}

function main() {
  const games = Number(process.argv[2]) || 250;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!bases.length) bases.push(1, 1001, 2001, 10001, 50001);

  const catalog = optionCatalog();
  const candidates = [
    ['delayedMerge', () => codex.makeDelayedRankedStrategy(codex.DELAYED_MERGE_RANKED_OPTIONS)],
  ];

  for (const [name, options] of catalog) {
    for (const cut of [2, 3, 4]) {
      candidates.push([`red<=${cut}:${name}`, () => makePostWaitSelector({
        cut,
        feature: 'red',
        rescue: options,
      })]);
    }
    for (const cut of [6, 7, 8]) {
      candidates.push([`gap>=${cut}:${name}`, () => makePostWaitSelector({
        cut,
        feature: 'gap',
        rescue: options,
      })]);
    }
    for (const cut of [9, 12, 15]) {
      candidates.push([`good<=${cut}:${name}`, () => makePostWaitSelector({
        cut,
        feature: 'good',
        rescue: options,
      })]);
    }
  }

  const rows = candidates.map(([name, factory]) => scoreCandidate(name, factory, games, bases));
  rows.sort((a, b) => b.total - a.total);
  for (const row of rows.slice(0, 40)) {
    console.log(`${row.name.padEnd(30)} ${String(row.total).padStart(4)}/${games * bases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  makePostWaitSelector,
};

