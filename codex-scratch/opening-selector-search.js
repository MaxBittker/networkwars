'use strict';

// Strict scratch search: tiny interpretable opening-feature selectors between
// legal deterministic policies. No board fingerprints, no seed/RNG use.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');
const { makeStateSwitchPressure } = require('./state-switch-pressure');
const { makeOrderPressure } = require('./order-pressure');

function components(state, faction) {
  const seen = new Set();
  const comps = [];
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
    comps.push(comp);
  }
  return comps;
}

function legalMoves(state) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== 'red' || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) if (state.nodes[to].owner !== 'red') moves.push({ from: n.id, to });
  }
  return moves;
}

function openingFeatures(seed) {
  const rng = G.makeRng(seed >>> 0);
  const state = { ...G.buildBoard(rng) };
  const red = state.nodes.filter(n => n.owner === 'red');
  const comps = components(state, 'red');
  const legal = legalMoves(state);
  let ok = 0;
  let bestP = 0;
  let weakTargets = 0;
  for (const m of legal) {
    const p = codex.captureProbability(state.nodes[m.from].strength, state.nodes[m.to].strength);
    if (p > 0.4) ok++;
    if (state.nodes[m.to].strength <= 2) weakTargets++;
    bestP = Math.max(bestP, p);
  }
  return {
    ok,
    legal: legal.length,
    bestP: Math.round(bestP * 100),
    weakTargets,
    redMax: Math.max(...red.map(n => n.strength)),
    redTotal: red.reduce((sum, n) => sum + n.strength, 0),
    largest: comps.reduce((best, comp) => Math.max(best, comp.length), 0),
    comps: comps.length,
  };
}

const policyFactories = {
  pressure: () => codex.makePressureStrategy(),
  strategy: () => codex.makeOpeningSelectorStrategy(),
  c1: () => codex.makeRankedStrategy(codex.C1_RANKED_OPTIONS),
  c4: () => codex.makeRankedStrategy(codex.C4_RANKED_OPTIONS),
  legacy: () => codex.makeRankedStrategy(codex.LEGACY_TUNED_RANKED_OPTIONS),
  state8: () => makeStateSwitchPressure({ redCut: 8, largestCut: 4, behindCut: 99 }),
  orderGB: () => makeOrderPressure({ ownerBonus: { green: 8, yellow: 0, blue: 8, purple: -3 }, countScaled: 0.2 }),
};

function buildRows(games, seedBases) {
  const rows = [];
  for (const seedBase of seedBases) {
    for (let i = 0; i < games; i++) {
      const seed = seedBase + i;
      const outcomes = {};
      for (const [name, factory] of Object.entries(policyFactories)) {
        outcomes[name] = sim.playGame(factory(), seed).won;
      }
      rows.push({ seed, features: openingFeatures(seed), outcomes });
    }
  }
  return rows;
}

function scoreRows(rows, chooser) {
  let wins = 0;
  for (const row of rows) {
    if (row.outcomes[chooser(row.features)]) wins++;
  }
  return wins;
}

function bestConstant(rows) {
  let best = null;
  for (const name of Object.keys(policyFactories)) {
    const wins = scoreRows(rows, () => name);
    if (!best || wins > best.wins) best = { wins, desc: name, chooser: () => name };
  }
  return best;
}

function bestStump(rows) {
  const constants = Object.keys(policyFactories);
  const features = Object.keys(rows[0].features);
  let best = bestConstant(rows);
  for (const feature of features) {
    const values = [...new Set(rows.map(r => r.features[feature]))].sort((a, b) => a - b);
    for (const cut of values) {
      for (const left of constants) {
        for (const right of constants) {
          if (left === right) continue;
          const chooser = f => (f[feature] <= cut ? left : right);
          const wins = scoreRows(rows, chooser);
          if (wins > best.wins) {
            best = { wins, desc: `${feature}<=${cut}?${left}:${right}`, chooser };
          }
        }
      }
    }
  }
  return best;
}

function main() {
  const games = Number(process.argv[2]) || 300;
  const trainBases = [1, 1001, 2001, 10001, 50001];
  const testBases = [900001, 910001];
  const train = buildRows(games, trainBases);
  const test = buildRows(games, testBases);
  const constant = bestConstant(train);
  const stump = bestStump(train);
  for (const model of [constant, stump]) {
    console.log(`${model.desc}`);
    console.log(`  train ${model.wins}/${train.length}`);
    console.log(`  test  ${scoreRows(test, model.chooser)}/${test.length}`);
  }
  console.log('test constants');
  for (const name of Object.keys(policyFactories)) {
    console.log(`  ${name.padEnd(8)} ${scoreRows(test, () => name)}/${test.length}`);
  }
}

if (require.main === module) main();
