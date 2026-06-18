'use strict';

// Strict diagnostic: hold the visible initial board fixed, resample future
// battle RNG streams, and compare legal policies. This does not define a valid
// production strategy; it estimates how much portfolio choice helps when future
// battle randomness is not known.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');
const experiments = require('../experiments');
// Imports generated ranked option arrays only; does not call seedOracleStrategy,
// recoverSeed, or api.rng().
const seedOracle = require('../codex-strategy/seed-oracle');

const policies = {
  pressure: () => codex.makePressureStrategy(),
  strategy: () => codex.makeOpeningSelectorStrategy(),
  c1: () => codex.makeRankedStrategy(codex.C1_RANKED_OPTIONS),
  c4: () => codex.makeRankedStrategy(codex.C4_RANKED_OPTIONS),
  legacy: () => codex.makeRankedStrategy(codex.LEGACY_TUNED_RANKED_OPTIONS),
  deny15: () => experiments.makeDenyLeader(0.15),
  connect: () => experiments.makeConnect(0.20, true),
};

function addWidePolicies(out) {
  for (const [name, options] of seedOracle.GENERATED_RANKED_OPTIONS) {
    if ([
      'rankedRand.16',
      'rankedRand.35',
      'rankedRand.139',
      'rankedRand.187',
      'rankedRand.226',
    ].includes(name)) {
      out[name] = () => codex.makeRankedStrategy(options);
    }
  }
  for (const [name, options] of seedOracle.TARGETED_RANKED_OPTIONS) {
    if ([
      'targetRand.7.284',
      'targetRand.99.1',
      'targetRand.123456.217',
      'targetRand.314159.266',
    ].includes(name)) {
      out[name] = () => codex.makeRankedStrategy(options);
    }
  }
}

function cloneBoard(board) {
  return {
    nodes: board.nodes.map(n => ({
      id: n.id,
      x: n.x,
      y: n.y,
      owner: n.owner,
      strength: n.strength,
    })),
    links: board.links.map(([a, b]) => [a, b]),
    adj: board.adj.map(nbs => nbs.slice()),
  };
}

function makeBoard(seed) {
  return G.buildBoard(G.makeRng(seed >>> 0));
}

function playOnBoard(policy, board, battleSeed) {
  const state = {
    ...cloneBoard(board),
    rng: G.makeRng(battleSeed >>> 0),
    policyRng: G.makeRng((battleSeed ^ 0x9e3779b9) >>> 0),
  };
  let turns = 0;
  while (!G.checkWinner(state) && turns < 300) {
    turns++;
    try { policy(sim.turnApi(state, G.HUMAN)); } catch (_) {}
    if (G.checkWinner(state)) break;
    G.reinforce(state, G.HUMAN);
    if (G.checkWinner(state)) break;
    const log = [];
    for (const bot of G.BOTS) {
      G.runBotTurn(state, bot, log);
      if (G.checkWinner(state)) break;
    }
  }
  return G.checkWinner(state) === G.HUMAN;
}

function main() {
  const boards = Number(process.argv[2]) || 120;
  const samples = Number(process.argv[3]) || 12;
  const boardBase = Number(process.argv[4]) || 1;
  const activePolicies = { ...policies };
  if (process.argv.includes('--wide')) addWidePolicies(activePolicies);
  const names = Object.keys(activePolicies);
  const totals = Object.fromEntries(names.map(name => [name, 0]));
  let portfolioBest = 0;
  let portfolioMajority = 0;

  for (let i = 0; i < boards; i++) {
    const boardSeed = boardBase + i;
    const board = makeBoard(boardSeed);
    const wins = Object.fromEntries(names.map(name => [name, 0]));

    for (const name of names) {
      for (let s = 0; s < samples; s++) {
        const battleSeed = ((boardSeed * 1000003) ^ (s * 9176) ^ 0xA511E9B3) >>> 0;
        if (playOnBoard(activePolicies[name](), board, battleSeed)) wins[name]++;
      }
      totals[name] += wins[name];
    }

    const best = Math.max(...Object.values(wins));
    portfolioBest += best;
    if (best > samples / 2) portfolioMajority++;
  }

  const denom = boards * samples;
  console.log(`boards=${boards} samples=${samples} boardBase=${boardBase}`);
  for (const name of names) {
    console.log(`${name.padEnd(10)} ${String(totals[name]).padStart(5)}/${denom} ${(totals[name] / denom * 100).toFixed(1)}%`);
  }
  console.log(`${'bestEach'.padEnd(10)} ${String(portfolioBest).padStart(5)}/${denom} ${(portfolioBest / denom * 100).toFixed(1)}%`);
  console.log(`${'best>50%'.padEnd(10)} ${String(portfolioMajority).padStart(5)}/${boards} ${(portfolioMajority / boards * 100).toFixed(1)}%`);
}

if (require.main === module) main();
