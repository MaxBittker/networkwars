'use strict';
// Dump per-seed game outcomes for two sample policies as JSON, so the Python
// port can be verified against the JS engine (see verify_port.py).
const sim = require('../sim');

const GAMES = 200;
const out = {};
for (const name of ['safeExpand', 'randomAll']) {
  out[name] = [];
  for (let seed = 1; seed <= GAMES; seed++) {
    const r = sim.playGame(sim.SAMPLE_POLICIES[name], seed);
    out[name].push({ seed, winner: r.winner, turns: r.turns, counts: r.counts });
  }
}
console.log(JSON.stringify(out));
