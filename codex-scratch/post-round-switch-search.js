'use strict';

// Strict scratch experiment: after the shared modal opening and first bot round,
// choose one simple midgame config from public board features. Offline search
// uses seed ranges only to measure generalization; runtime policies produced by
// this file use no api.rng(), seed recovery, board lookup, live-node mutation,
// or benchmark-order state.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';
const WIN_NODES = 24;

const CONFIGS = {
  current: { topK: 6, countWeight: 14, minScore: 210 },
  top5: { topK: 5, countWeight: 12, minScore: 210 },
  fast: { topK: 2, countWeight: 4, minScore: 210 },
  active200: { topK: 6, countWeight: 14, minScore: 200 },
  cautious220: { topK: 6, countWeight: 14, minScore: 220 },
  red36: { topK: 6, countWeight: 14, minScore: 210, redGainWeight: 36 },
  large28: { topK: 6, countWeight: 14, minScore: 210, largestWeight: 28 },
};

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

function riskStats(state) {
  let risk = 0;
  let threatened = 0;
  let beatable = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const nb of state.adj[n.id]) {
      const target = state.nodes[nb];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      risk += p;
      beatable++;
      if (p > 0.45) threatened++;
    }
  }
  return { risk, threatened, beatable };
}

function stateFeatures(state) {
  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redNodes = state.nodes.filter(n => n.owner === HUMAN);
  const redStrength = redNodes.reduce((sum, n) => sum + n.strength, 0);
  let weakBorder = 0;
  let strongBorder = 0;
  for (const n of redNodes) {
    if (!state.adj[n.id].some(nb => state.nodes[nb].owner !== HUMAN)) continue;
    if (n.strength <= 2) weakBorder++;
    if (n.strength >= 4) strongBorder++;
  }
  const risk = riskStats(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  return {
    red: c.red,
    maxEnemy,
    gap: maxEnemy - c.red,
    largest,
    splits: Math.max(0, redComps.length - 1),
    legal: legalMoves(state).length,
    risk10: Math.round(risk.risk * 10),
    threatened: risk.threatened,
    beatable: risk.beatable,
    weakBorder,
    strongBorder,
    redStrength,
    strengthPerNode10: c.red ? Math.round((redStrength / c.red) * 10) : 0,
  };
}

function makeInitialState(seed) {
  const rng = G.makeRng(seed >>> 0);
  const board = G.buildBoard(rng);
  return { ...board, rng, policyRng: G.makeRng((seed ^ 0x9e3779b9) >>> 0) };
}

function playToSecondRedTurn(seed) {
  const state = makeInitialState(seed);
  const policy = codex.codexModalOpeningGap;
  try { policy(sim.turnApi(state, HUMAN)); } catch (_) {}
  if (!G.checkWinner(state)) G.reinforce(state, HUMAN);
  if (!G.checkWinner(state)) {
    for (const bot of G.BOTS) {
      G.runBotTurn(state, bot, []);
      if (G.checkWinner(state)) break;
    }
  }
  return stateFeatures(state);
}

function moveConfigForState(state, config) {
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  return {
    rankedOptions: codex.DELAYED_MERGE_RANKED_OPTIONS,
    splitWeight: 25,
    threatenedWeight: maxEnemy - c.red >= 2 ? 36 : 16,
    ...config,
  };
}

function makeModalConfigStrategy(config) {
  let openingHandled = false;

  return function modalConfig(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) openingHandled = false;

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < 2; i++) {
        const state = cloneFromApi(api);
        const move = codex.selectModalOpeningMove(state);
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    for (let attacks = 0; attacks < 120; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = codex.selectSafetyRankedMove(state, moveConfigForState(state, config));
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function choose(tree, features) {
  if (tree.type === 'leaf') return tree.config;
  return choose(features[tree.feature] <= tree.cut ? tree.left : tree.right, features);
}

function makePostRoundSwitch(tree) {
  let openingHandled = false;
  let selected = null;

  return function postRoundSwitch(api) {
    const initial = cloneFromApi(api);
    if (isOpening(initial)) {
      openingHandled = false;
      selected = null;
    }

    if (!openingHandled && isOpening(initial)) {
      openingHandled = true;
      for (let i = 0; i < 2; i++) {
        const state = cloneFromApi(api);
        const move = codex.selectModalOpeningMove(state);
        if (!move) return;
        api.attack(move.from, move.to);
      }
      return;
    }

    if (!selected) {
      selected = CONFIGS[choose(tree, stateFeatures(initial))] || CONFIGS.current;
    }

    for (let attacks = 0; attacks < 120; attacks++) {
      const state = cloneFromApi(api);
      if (counts(state).red >= WIN_NODES) return;
      const move = codex.selectSafetyRankedMove(state, moveConfigForState(state, selected));
      if (!move) return;
      api.attack(move.from, move.to);
    }
  };
}

function collect(games, bases, configNames) {
  const rows = [];
  const factories = Object.fromEntries(configNames.map(name => [name, () => makeModalConfigStrategy(CONFIGS[name])]));
  for (const seedBase of bases) {
    for (let i = 0; i < games; i++) {
      const seed = seedBase + i;
      const outcomes = {};
      for (const name of configNames) outcomes[name] = sim.playGame(factories[name](), seed).won;
      rows.push({ seed, features: playToSecondRedTurn(seed), outcomes });
    }
  }
  return rows;
}

function bestLeaf(rows, configNames) {
  let best = configNames[0];
  let wins = -1;
  for (const name of configNames) {
    const current = rows.reduce((sum, row) => sum + (row.outcomes[name] ? 1 : 0), 0);
    if (current > wins) {
      best = name;
      wins = current;
    }
  }
  return { type: 'leaf', config: best, wins, total: rows.length };
}

function scoreTree(tree, rows) {
  return rows.reduce((sum, row) => sum + (row.outcomes[choose(tree, row.features)] ? 1 : 0), 0);
}

function candidateCuts(rows, feature) {
  const values = [...new Set(rows.map(row => row.features[feature]))].sort((a, b) => a - b);
  const cuts = [];
  for (let i = 0; i < values.length - 1; i++) cuts.push(values[i]);
  return cuts;
}

function buildTree(rows, configNames, depth, minLeaf, minGain) {
  const leaf = bestLeaf(rows, configNames);
  if (depth <= 0 || rows.length < minLeaf * 2) return leaf;
  let best = null;
  for (const feature of Object.keys(rows[0].features)) {
    for (const cut of candidateCuts(rows, feature)) {
      const leftRows = rows.filter(row => row.features[feature] <= cut);
      const rightRows = rows.filter(row => row.features[feature] > cut);
      if (leftRows.length < minLeaf || rightRows.length < minLeaf) continue;
      const left = buildTree(leftRows, configNames, depth - 1, minLeaf, minGain);
      const right = buildTree(rightRows, configNames, depth - 1, minLeaf, minGain);
      const wins = scoreTree(left, leftRows) + scoreTree(right, rightRows);
      if (!best || wins > best.wins) {
        best = { type: 'split', feature, cut, left, right, wins, total: rows.length };
      }
    }
  }
  return best && best.wins >= leaf.wins + minGain ? best : leaf;
}

function formatTree(tree, indent = '') {
  if (tree.type === 'leaf') return `${indent}${tree.config} (${tree.wins}/${tree.total})`;
  return [
    `${indent}if ${tree.feature} <= ${tree.cut}:`,
    formatTree(tree.left, `${indent}  `),
    `${indent}else:`,
    formatTree(tree.right, `${indent}  `),
  ].join('\n');
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map(Number).filter(Number.isFinite);
}

function argValue(name) {
  const prefix = `${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function main() {
  const games = Number(argValue('games')) || 80;
  const trainBases = parseList(argValue('train'), [1, 1001, 2001, 10001]);
  const validBases = parseList(argValue('valid'), [50001, 900001, 910001, 920001]);
  const depth = Number(argValue('depth')) || 2;
  const minLeaf = Number(argValue('minLeaf')) || 80;
  const minGain = Number(argValue('minGain')) || 4;
  const configNames = (argValue('configs') || 'current,top5,fast,active200,cautious220,red36,large28')
    .split(',')
    .map(name => name.trim())
    .filter(name => CONFIGS[name]);

  const train = collect(games, trainBases, configNames);
  const valid = collect(games, validBases, configNames);
  const tree = buildTree(train, configNames, depth, minLeaf, minGain);
  console.log(`train rows ${train.length}, valid rows ${valid.length}, configs ${configNames.join(',')}`);
  console.log(formatTree(tree));
  console.log(`tree train ${scoreTree(tree, train)}/${train.length}`);
  console.log(`tree valid ${scoreTree(tree, valid)}/${valid.length}`);
  for (const name of configNames) {
    const trainWins = train.reduce((sum, row) => sum + (row.outcomes[name] ? 1 : 0), 0);
    const validWins = valid.reduce((sum, row) => sum + (row.outcomes[name] ? 1 : 0), 0);
    console.log(`${name.padEnd(12)} train ${String(trainWins).padStart(4)}/${train.length}  valid ${String(validWins).padStart(4)}/${valid.length}`);
  }
}

if (require.main === module) main();

module.exports = {
  CONFIGS,
  stateFeatures,
  buildTree,
  choose,
  makePostRoundSwitch,
  makeModalConfigStrategy,
};
