'use strict';

// Strict scratch experiment: learn a tiny decision tree over coarse visible
// opening features to select among a small fixed set of legal strict policies.
// The runtime policy does not use seeds, board fingerprints, api.rng(), live
// node mutation, or cross-game benchmark state.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';

const POLICIES = {
  k2: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }),
  threat36: () => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25, threatenedWeight: 36 }),
  openingDefense: () => codex.makeOpeningDefenseDelayStrategy(),
  delayedMerge: () => codex.makeDelayedRankedStrategy(codex.DELAYED_MERGE_RANKED_OPTIONS),
  pressure: () => codex.makePressureStrategy(),
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

function coarseFeaturesFromState(state) {
  const moves = legalMoves(state);
  const redNodes = state.nodes.filter(n => n.owner === HUMAN);
  const redStrengths = redNodes.map(n => n.strength);
  const comps = components(state, HUMAN);
  const largest = comps.reduce((best, comp) => Math.max(best, comp.length), 0);
  let pSum = 0;
  let pMax = 0;
  let good04 = 0;
  let good05 = 0;
  let high07 = 0;
  let weakTargets = 0;
  let mergeTargets = 0;
  let enemyBeatsRed = 0;
  let redAdj = 0;
  let redWeakAdj = 0;
  let redStrongAdj = 0;
  const enemyTouch = new Set();
  const compByNode = new Map();
  comps.forEach((comp, index) => {
    for (const id of comp) compByNode.set(id, index);
  });

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
    for (const nbId of state.adj[to.id]) {
      if (state.nodes[nbId].owner === HUMAN) touching.add(compByNode.get(nbId));
    }
    if (touching.size > 1) mergeTargets++;
  }

  for (const red of redNodes) {
    for (const nbId of state.adj[red.id]) {
      const nb = state.nodes[nbId];
      if (nb.owner === HUMAN) continue;
      redAdj++;
      if (nb.strength > red.strength) enemyBeatsRed++;
      if (red.strength <= 2) redWeakAdj++;
      if (red.strength >= 4) redStrongAdj++;
    }
  }

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
    enemyBeatsRed,
    redAdj,
    redWeakAdj,
    redStrongAdj,
    enemyTouch: enemyTouch.size,
  };
}

function policyResult(factory, seed) {
  return sim.playGame(factory(), seed).won;
}

function collect(games, bases, policyNames = Object.keys(POLICIES)) {
  const rows = [];
  for (const seedBase of bases) {
    for (let i = 0; i < games; i++) {
      const seed = seedBase + i;
      const outcomes = {};
      for (const name of policyNames) {
        outcomes[name] = policyResult(POLICIES[name], seed);
      }
      rows.push({ seed, features: coarseFeaturesFromState(makeInitialState(seed)), outcomes });
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

function scoreTree(tree, rows) {
  let wins = 0;
  for (const row of rows) {
    const policy = chooseTreePolicy(tree, row.features);
    if (row.outcomes[policy]) wins++;
  }
  return wins;
}

function chooseTreePolicy(tree, features) {
  if (tree.type === 'leaf') return tree.policy;
  const left = features[tree.feature] <= tree.cut;
  return chooseTreePolicy(left ? tree.left : tree.right, features);
}

function candidateCuts(rows, feature) {
  const values = [...new Set(rows.map(row => row.features[feature]))].sort((a, b) => a - b);
  const cuts = [];
  for (let i = 0; i < values.length - 1; i++) {
    cuts.push(values[i]);
  }
  return cuts;
}

function buildTree(rows, policyNames, depth, minLeaf = 35, minGain = 3) {
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
  if (tree.type === 'leaf') {
    return `${indent}${tree.policy} (${tree.wins}/${tree.total})`;
  }
  return [
    `${indent}if ${tree.feature} <= ${tree.cut}:`,
    formatTree(tree.left, `${indent}  `),
    `${indent}else:`,
    formatTree(tree.right, `${indent}  `),
  ].join('\n');
}

function treeToRuntime(tree) {
  if (tree.type === 'leaf') return { type: 'leaf', policy: tree.policy };
  return {
    type: 'split',
    feature: tree.feature,
    cut: tree.cut,
    left: treeToRuntime(tree.left),
    right: treeToRuntime(tree.right),
  };
}

function makeTreeSelector(tree) {
  const runtimeTree = treeToRuntime(tree);
  return function factory() {
    let selected = null;
    let selectedPolicy = null;
    return function tinyTreeSelector(api) {
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
      if (opening || !selectedPolicy) {
        if (opening) {
          selected = chooseRuntimePolicy(runtimeTree, coarseFeaturesFromState(state));
        } else {
          selected = 'k2';
        }
        selectedPolicy = POLICIES[selected]();
      }
      return selectedPolicy(api);
    };
  };
}

function chooseRuntimePolicy(tree, features) {
  if (tree.type === 'leaf') return tree.policy;
  return chooseRuntimePolicy(features[tree.feature] <= tree.cut ? tree.left : tree.right, features);
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
  const games = Number(process.argv[2]) || 120;
  const trainBases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  const bases = trainBases.length ? trainBases : [1, 1001, 10001];
  const policyNames = Object.keys(POLICIES);
  const rows = collect(games, bases, policyNames);

  const tree = buildTree(rows, policyNames, 2, 35, 4);
  console.log(`training rows ${rows.length}`);
  console.log(formatTree(tree));
  console.log(`training tree ${scoreTree(tree, rows)}/${rows.length}`);
  for (const name of policyNames) {
    const wins = rows.reduce((sum, row) => sum + (row.outcomes[name] ? 1 : 0), 0);
    console.log(`training ${name.padEnd(14)} ${wins}/${rows.length}`);
  }

  const validateBases = [1, 1001, 2001, 10001, 50001];
  const candidates = [
    ['tree', makeTreeSelector(tree)],
    ['k2', POLICIES.k2],
    ['threat36', POLICIES.threat36],
    ['openingDefense', POLICIES.openingDefense],
    ['delayedMerge', POLICIES.delayedMerge],
    ['pressure', POLICIES.pressure],
  ];
  console.log('\nvalidation');
  const results = candidates.map(([name, factory]) => validateFactory(name, factory, games, validateBases));
  results.sort((a, b) => b.total - a.total);
  for (const row of results) {
    console.log(`${row.name.padEnd(16)} ${String(row.total).padStart(4)}/${games * validateBases.length}  ${row.parts.join('  ')}  ${row.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  POLICIES,
  buildTree,
  collect,
  coarseFeaturesFromState,
  makeTreeSelector,
  validateFactory,
};
