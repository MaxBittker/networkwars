'use strict';
// Generate boards from seeds (identical distribution to sim.js) and pipe them to
// the native engine; parse the aggregate win rate. Board generation is the only
// thing that must stay in JS to match the existing benchmark's seed→board map.
const { execFileSync } = require('child_process');
const G = require('../game');
const FAC = { red:0, green:1, yellow:2, blue:3, purple:4 };

function dumpBoards(games, seedBase) {
  const out = [String(games)];
  for (let i = 0; i < games; i++) {
    const seed = seedBase + i;
    const rng = G.makeRng(seed >>> 0);
    const { nodes, links } = G.buildBoard(rng);
    out.push(`${seed} ${nodes.length} ${links.length}`);
    for (const n of nodes) out.push(`${FAC[n.owner]} ${n.strength}`);
    for (const [a, b] of links) out.push(`${a} ${b}`);
  }
  return out.join('\n') + '\n';
}

const games = Number(process.argv[2]) || 500;
const seedBase = Number(process.argv[3]) || 1;
const extra = process.argv.slice(4);          // passed through to the binary
const input = dumpBoards(games, seedBase);
const t0 = process.hrtime.bigint();
const res = execFileSync(__dirname + '/nw', extra, { input, maxBuffer: 1 << 28 }).toString().trim();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const [wins, n, rate] = res.split(/\s+/);
console.log(`${(rate*100).toFixed(1)}%  (${wins}/${n})  seeds ${seedBase}..${seedBase+games-1}  ${(ms).toFixed(0)}ms total, ${(ms/games).toFixed(2)}ms/game  [${extra.join(' ')}]`);
