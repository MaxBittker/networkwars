'use strict';

// Strict scratch experiment: learn a tiny decision tree over visible opening
// features to choose among a fixed set of legal strategy variants. Runtime uses
// only the public board state; it does not use seeds, api.rng(), board
// fingerprints, live-node mutation, or benchmark-order state.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';

const POLICIES = {
  current: () => codex.codexSafetyGap2Threat,
  top6: () => codex.codexSafetyGap2ThreatTop6,
  top5: () => codex.codexSafetyGap2ThreatTop5,
  fast: () => codex.codexSafetyGap2ThreatFast,
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

function riskStats(state) {
  let risk = 0;
  let threatened = 0;
  let enemyBeatsRed = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner !== HUMAN) continue;
      if (n.strength > target.strength) {
        const p = codex.captureProbability(n.strength, target.strength);
        risk += p;
        enemyBeatsRed++;
        if (p > 0.45) threatened++;
      }
    }
  }
  return { risk, threatened, enemyBeatsRed };
}

function openingFeaturesFromState(state) {
  const moves = legalMoves(state);
  const redNodes = state.nodes.filter(n => n.owner === HUMAN);
  const redStrengths = redNodes.map(n => n.strength);
  const comps = components(state, HUMAN);
  const largest = comps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const compByNode = new Map();
  comps.forEach((comp, idx) => {
    for (const id of comp) compByNode.set(id, idx);
  });

  let pSum = 0;
  let pMax = 0;
  let good04 = 0;
  let good05 = 0;
  let high07 = 0;
  let weakTargets = 0;
  let mergeTargets = 0;
  let redAdj = 0;
  let redWeakAdj = 0;
  let redStrongAdj = 0;
  const enemyTouch = new Set();

  for (const move of moves) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    pSum += p;
    pMax = Math.max(pMax, p);
    if (p > 0.4) good04++;
    if (p > 0.5) good05++;
    if (p > 0.7) high07++;
    if (to.strength <= 2) weakTargets++;
    enemyTouch.add(to.owner);

    const touching = new Set([compByNode.get(from.id)]);
    for (const nb of state.adj[to.id]) {
      if (state.nodes[nb].owner === HUMAN) touching.add(compByNode.get(nb));
    }
    if (touching.size > 1) mergeTargets++;
  }

  for (const red of redNodes) {
    for (const nbId of state.adj[red.id]) {
      const nb = state.nodes[nbId];
      if (nb.owner === HUMAN) continue;
      redAdj++;
      if (red.strength <= 2) redWeakAdj++;
      if (red.strength >= 4) redStrongAdj++;
    }
  }

  const risk = riskStats(state);
  return {
    legal: moves.length,
    good04,
    good05,
    high07,
    pAvg10: moves.length ? Math.round((pSum / moves.length) * 10) : 0,
    pMax10: Math.round(pMax * 10),
    weakTargets,
    mergeTargets,
    redTotal: redStrengths.reduce((a, b) => a + b, 0),
    redMax: redStrengths.reduce((a, b) => Math.max(a, b), 0),
    redMin: redStrengths.reduce((a, b) => Math.min(a, b), 99),
    redGte4: redStrengths.filter(v => v >= 4).length,
    redLte2: redStrengths.filter(v => v <= 2).length,
    largest,
    redComps: comps.length,
    redAdj,
    redWeakAdj,
    redStrongAdj,
    enemyTouch: enemyTouch.size,
    risk10: Math.round(risk.risk * 10),
    threatened: risk.threatened,
    enemyBeatsRed: risk.enemyBeatsRed,
  };
}

function openingFeatures(seed) {
  return openingFeaturesFromState(makeInitialState(seed));
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
      rows.push({ seed, features: openingFeatures(seed), outcomes });
    }
  }
  return rows;
}

function bestLeaf(rows, policyNames) {
  let best = policyNames[0];
  let bestWins = -1;
  for (const name of policyNames) {
    const wins = rows.reduce((sum, row) => sum + (row.outcomes[name] ? 1 : 0), 0);
    if (wins > bestWins) {
      best = name;
      bestWins = wins;
    }
  }
  return { type: 'leaf', policy: best, wins: bestWins, total: rows.length };
}

function chooseTreePolicy(tree, features) {
  if (tree.type === 'leaf') return tree.policy;
  return chooseTreePolicy(features[tree.feature] <= tree.cut ? tree.left : tree.right, features);
}

function scoreTree(tree, rows) {
  return rows.reduce((sum, row) => sum + (row.outcomes[chooseTreePolicy(tree, row.features)] ? 1 : 0), 0);
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
  for (const feature of Object.keys(rows[0].features)) {
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

function runtimeTree(tree) {
  if (tree.type === 'leaf') return { type: 'leaf', policy: tree.policy };
  return {
    type: 'split',
    feature: tree.feature,
    cut: tree.cut,
    left: runtimeTree(tree.left),
    right: runtimeTree(tree.right),
  };
}

function makeTreeSelector(tree) {
  const rt = runtimeTree(tree);
  return function factory() {
    let selected = null;
    let policy = null;
    return function treeSelector(api) {
      const state = {
        nodes: api.nodes.map(n => ({
          id: n.id,
          x: n.x,
          y: n.y,
          owner: n.owner,
          strength: n.strength,
        })),
        adj: api.nodes.map(n => api.neighbors(n.id).slice()),
      };
      const c = counts(state);
      const opening = FACTIONS.every(f => c[f] === 6)
        && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);
      if (opening || !policy) {
        selected = opening ? chooseTreePolicy(rt, openingFeaturesFromState(state)) : 'current';
        policy = POLICIES[selected]();
      }
      return policy(api);
    };
  };
}

function validateFactory(name, factory, games, bases) {
  let total = 0;
  let totalMs = 0;
  const parts = [];
  for (const seedBase of bases) {
    const result = sim.scorePolicy(factory(), { games, seedBase });
    total += result.wins;
    totalMs += result.totalMs;
    parts.push(`${seedBase}:${result.wins}/${games}`);
  }
  return { name, total, parts, msPerGame: totalMs / (games * bases.length) };
}

function main() {
  const games = Number(process.argv[2]) || 200;
  const depth = Number(process.argv[3]) || 2;
  const policyNames = process.argv[4]
    ? process.argv[4].split(',').filter(name => POLICIES[name])
    : Object.keys(POLICIES);
  const trainBases = [1, 1001, 2001, 10001, 50001];
  const rows = collect(games, trainBases, policyNames);
  const tree = buildTree(rows, policyNames, depth, Math.max(35, Math.floor(rows.length * 0.06)), 4);
  console.log(`training rows=${rows.length} depth=${depth} policies=${policyNames.join(',')}`);
  console.log(formatTree(tree));
  console.log(`training tree ${scoreTree(tree, rows)}/${rows.length}`);
  for (const name of policyNames) {
    const wins = rows.reduce((sum, row) => sum + (row.outcomes[name] ? 1 : 0), 0);
    console.log(`training ${name.padEnd(10)} ${wins}/${rows.length}`);
  }

  const validateBases = [900001, 910001, 920001, 930001, 940001];
  const candidates = [
    ['tree', makeTreeSelector(tree)],
    ...policyNames.map(name => [name, POLICIES[name]]),
  ];
  console.log('\nvalidation');
  const results = candidates.map(([name, factory]) => validateFactory(name, factory, games, validateBases));
  results.sort((a, b) => b.total - a.total || a.msPerGame - b.msPerGame);
  for (const row of results) {
    console.log(`${row.name.padEnd(10)} ${String(row.total).padStart(4)}/${games * validateBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  POLICIES,
  buildTree,
  collect,
  formatTree,
  makeTreeSelector,
  openingFeaturesFromState,
  validateFactory,
};

