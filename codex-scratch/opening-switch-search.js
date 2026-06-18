'use strict';

// Strict scratch experiment: learn a tiny public-opening-feature switch among
// existing strict policies. Runtime selectors produced by this script use only
// the visible opening board. The offline search observes seeds only to measure
// generalization; it does not feed seeds, api.rng(), board fingerprints, or
// benchmark-order state into a production policy.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';

const POLICIES = {
  modal: () => codex.codexModalOpeningGap,
  fast: () => codex.codexSafetyGap2ThreatFast,
  top5: () => codex.codexSafetyGap2ThreatTop5,
  gap5: () => codex.codexSafetyGap2Threat,
  threat36: () => codex.codexSafetyThreat36,
  k2: () => codex.codexSafetyK2,
};

function makeInitialState(seed) {
  const rng = G.makeRng(seed >>> 0);
  return { ...G.buildBoard(rng), rng };
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

function openingFeatures(state) {
  const moves = legalMoves(state);
  const redNodes = state.nodes.filter(n => n.owner === HUMAN);
  const redStrengths = redNodes.map(n => n.strength);
  const comps = components(state, HUMAN);
  const compByNode = new Map();
  comps.forEach((comp, index) => {
    for (const id of comp) compByNode.set(id, index);
  });

  let pSum = 0;
  let pMax = 0;
  let good04 = 0;
  let good055 = 0;
  let high07 = 0;
  let weakTargets = 0;
  let mergeTargets = 0;
  let leaderTargets = 0;
  let enemyBeatsRed = 0;
  let risk = 0;
  const c = counts(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));

  for (const move of moves) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    pSum += p;
    pMax = Math.max(pMax, p);
    if (p > 0.4) good04++;
    if (p > 0.55) good055++;
    if (p > 0.7) high07++;
    if (to.strength <= 2) weakTargets++;
    if (c[to.owner] === maxEnemy) leaderTargets++;

    const touching = new Set([compByNode.get(from.id)]);
    for (const nb of state.adj[to.id]) {
      if (state.nodes[nb].owner === HUMAN) touching.add(compByNode.get(nb));
    }
    if (touching.size > 1) mergeTargets++;
  }

  for (const red of redNodes) {
    for (const nb of state.adj[red.id]) {
      const enemy = state.nodes[nb];
      if (enemy.owner === HUMAN) continue;
      if (enemy.strength > red.strength) {
        enemyBeatsRed++;
        risk += codex.captureProbability(enemy.strength, red.strength);
      }
    }
  }

  return {
    legal: moves.length,
    good04,
    good055,
    high07,
    pAvg10: moves.length ? Math.round((pSum / moves.length) * 10) : 0,
    pMax10: Math.round(pMax * 10),
    weakTargets,
    mergeTargets,
    leaderTargets,
    redTotal: redStrengths.reduce((sum, v) => sum + v, 0),
    redMax: Math.max(...redStrengths),
    redMin: Math.min(...redStrengths),
    redGte4: redStrengths.filter(v => v >= 4).length,
    redLte2: redStrengths.filter(v => v <= 2).length,
    largest: comps.reduce((best, comp) => Math.max(best, comp.length), 0),
    redComps: comps.length,
    enemyBeatsRed,
    risk10: Math.round(risk * 10),
  };
}

function collect(games, bases, policyNames) {
  const rows = [];
  for (const seedBase of bases) {
    for (let i = 0; i < games; i++) {
      const seed = seedBase + i;
      const outcomes = {};
      for (const name of policyNames) {
        outcomes[name] = sim.playGame(POLICIES[name](), seed).won;
      }
      rows.push({ seed, features: openingFeatures(makeInitialState(seed)), outcomes });
    }
  }
  return rows;
}

function bestLeaf(rows, policyNames) {
  let best = policyNames[0];
  let wins = -1;
  for (const policy of policyNames) {
    const policyWins = rows.reduce((sum, row) => sum + (row.outcomes[policy] ? 1 : 0), 0);
    if (policyWins > wins) {
      best = policy;
      wins = policyWins;
    }
  }
  return { type: 'leaf', policy: best, wins, total: rows.length };
}

function choose(tree, features) {
  if (tree.type === 'leaf') return tree.policy;
  return choose(features[tree.feature] <= tree.cut ? tree.left : tree.right, features);
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

function buildTree(rows, policyNames, depth, minLeaf, minGain) {
  const leaf = bestLeaf(rows, policyNames);
  if (depth <= 0 || rows.length < minLeaf * 2) return leaf;

  let best = null;
  const features = Object.keys(rows[0].features);
  for (const feature of features) {
    for (const cut of candidateCuts(rows, feature)) {
      const leftRows = rows.filter(row => row.features[feature] <= cut);
      const rightRows = rows.filter(row => row.features[feature] > cut);
      if (leftRows.length < minLeaf || rightRows.length < minLeaf) continue;
      const left = buildTree(leftRows, policyNames, depth - 1, minLeaf, minGain);
      const right = buildTree(rightRows, policyNames, depth - 1, minLeaf, minGain);
      const wins = scoreTree(left, leftRows) + scoreTree(right, rightRows);
      if (!best || wins > best.wins) {
        best = { type: 'split', feature, cut, left, right, wins, total: rows.length };
      }
    }
  }

  return best && best.wins >= leaf.wins + minGain ? best : leaf;
}

function formatTree(tree, indent = '') {
  if (tree.type === 'leaf') return `${indent}${tree.policy} (${tree.wins}/${tree.total})`;
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
  const games = Number(argValue('games')) || 120;
  const trainBases = parseList(argValue('train'), [1, 1001, 2001, 10001]);
  const validBases = parseList(argValue('valid'), [50001, 900001, 910001, 920001]);
  const depth = Number(argValue('depth')) || 2;
  const minLeaf = Number(argValue('minLeaf')) || 80;
  const minGain = Number(argValue('minGain')) || 4;
  const policyNames = (argValue('policies') || 'modal,fast,top5,gap5,threat36,k2')
    .split(',')
    .map(name => name.trim())
    .filter(name => POLICIES[name]);

  const train = collect(games, trainBases, policyNames);
  const valid = collect(games, validBases, policyNames);
  const tree = buildTree(train, policyNames, depth, minLeaf, minGain);

  console.log(`train rows ${train.length}, valid rows ${valid.length}, policies ${policyNames.join(',')}`);
  console.log(formatTree(tree));
  console.log(`tree train ${scoreTree(tree, train)}/${train.length}`);
  console.log(`tree valid ${scoreTree(tree, valid)}/${valid.length}`);
  for (const name of policyNames) {
    const trainWins = train.reduce((sum, row) => sum + (row.outcomes[name] ? 1 : 0), 0);
    const validWins = valid.reduce((sum, row) => sum + (row.outcomes[name] ? 1 : 0), 0);
    console.log(`${name.padEnd(8)} train ${String(trainWins).padStart(4)}/${train.length}  valid ${String(validWins).padStart(4)}/${valid.length}`);
  }
}

if (require.main === module) main();

module.exports = {
  openingFeatures,
  buildTree,
  choose,
};
