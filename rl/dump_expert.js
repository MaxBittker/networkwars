'use strict';
// Dump modalScout (the ~68.7% expert) games as action streams for Python replay.
// Because rl/network_wars.py is a bit-identical port of game.js, replaying the
// same seed + same RED actions in Python reproduces the exact game, letting us
// build (obs, expert-move, outcome) training data with Python-consistent obs.
//
//   node dump_expert.js 5000 200000 > expert.jsonl
// args: <games> <seedBase>.  Seeds are kept DISJOINT from the eval range (1..N).

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const MAX_TURNS = 300;

function dumpGame(seed) {
  const state = sim.makeGame(seed);
  const policy = codex.makeModalScoutStrategy();  // fresh per game (stateful)
  const actions = [];                              // [from,to] attacks and 'end'
  let turns = 0;
  while (!G.checkWinner(state) && turns < MAX_TURNS) {
    turns++;
    const api = sim.turnApi(state, G.HUMAN);
    const wrapped = {
      faction: api.faction,
      get nodes() { return api.nodes; },
      node: api.node,
      counts: api.counts,
      neighbors: api.neighbors,
      legalMoves: api.legalMoves,
      rng: api.rng,
      attack: (f, t) => { actions.push([f, t]); return api.attack(f, t); },
    };
    try { policy(wrapped); } catch (_) { /* end turn on throw */ }
    actions.push('end');
    if (G.checkWinner(state)) break;
    G.reinforce(state, G.HUMAN);
    if (G.checkWinner(state)) break;
    for (const bot of G.BOTS) { G.runBotTurn(state, bot, []); if (G.checkWinner(state)) break; }
  }
  return { seed, winner: G.checkWinner(state), won: G.checkWinner(state) === G.HUMAN, actions };
}

const games = Number(process.argv[2]) || 5000;
const seedBase = Number(process.argv[3]) || 200000;
let wins = 0;
for (let i = 0; i < games; i++) {
  const r = dumpGame(seedBase + i);
  if (r.won) wins++;
  process.stdout.write(JSON.stringify(r) + '\n');
}
process.stderr.write(`dumped ${games} games, modalScout winrate ${(wins / games * 100).toFixed(1)}%\n`);
