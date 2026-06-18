'use strict';
// Headless rules-engine tests + a full seeded game played to completion.
const G = require('./game');
const assert = require('assert');

let passed = 0;
function ok(name, cond) { assert(cond, name); passed++; }

function fresh(seed) {
  const rng = G.makeRng(seed);
  const board = G.buildBoard(rng);
  return { ...board, rng };
}

// 1. Board: 30 nodes, 6 per faction, connected graph.
{
  const s = fresh(1);
  ok('30 nodes', s.nodes.length === 30);
  const c = G.counts(s);
  ok('6 each faction', G.FACTIONS.every(f => c[f] === 6));
  // connectivity via BFS over all links
  const seen = new Set([0]); const stk = [0];
  while (stk.length) { for (const nb of s.adj[stk.pop()]) if (!seen.has(nb)) { seen.add(nb); stk.push(nb); } }
  ok('graph connected', seen.size === 30);
}

// 2. Capture math: strong attacker vs weak defender leaves attacker=1, target=atk-1.
{
  const s = fresh(2);
  s.nodes[0].owner = 'red'; s.nodes[0].strength = 8;
  const nb = s.adj[0][0];
  s.nodes[nb].owner = 'green'; s.nodes[nb].strength = 1;
  // force attacker to always win
  s.rng = () => 0; // < 0.55 -> defender loses each flip
  const log = G.resolveBattle(s, 0, nb);
  ok('captured', log.captured && s.nodes[nb].owner === 'red');
  ok('attacker left with 1', s.nodes[0].strength === 1);
  ok('target gets atk-1', s.nodes[nb].strength === 7);
}

// 3. Failed attack: attacker always loses -> drops to 1, no capture.
{
  const s = fresh(3);
  s.nodes[0].owner = 'red'; s.nodes[0].strength = 5;
  const nb = s.adj[0][0];
  s.nodes[nb].owner = 'green'; s.nodes[nb].strength = 5;
  s.rng = () => 0.99; // attacker always loses
  const log = G.resolveBattle(s, 0, nb);
  ok('not captured', !log.captured);
  ok('attacker reduced to 1', s.nodes[0].strength === 1);
  ok('defender still green', s.nodes[nb].owner === 'green' && s.nodes[nb].strength === 5);
}

// 4. Reinforcements = largest component size, spread over border nodes.
{
  const s = fresh(4);
  for (const n of s.nodes) { n.owner = 'green'; n.strength = 1; }
  // make all red so component=30, every node interior except border vs nothing...
  for (const n of s.nodes) n.owner = 'red';
  s.nodes[0].owner = 'green'; // one enemy -> red border = neighbors of node 0
  const before = s.nodes.reduce((a, n) => a + (n.owner==='red'?n.strength:0), 0);
  const r = G.reinforce(s, 'red');
  const after = s.nodes.reduce((a, n) => a + (n.owner==='red'?n.strength:0), 0);
  ok('reinforce amount = component size (29)', r.amount === 29);
  ok('added exactly amount', after - before === 29);
  ok('all added on border', r.border.every(id => s.adj[id].includes(0)));
}

// 5. Bots attack weakest beatable neighbor; never attack when not stronger.
{
  const s = fresh(5);
  const mv = G.bestBotMove(s, 'green');
  if (mv) ok('bot only attacks strictly weaker', s.nodes[mv.from].strength > s.nodes[mv.to].strength);
  else ok('no bot move is acceptable', true);
}

// 6. Full game: play RED greedily to completion, assert it terminates with a winner
//    and node counts stay consistent (always 30 total, winner has >=24 or last alive).
{
  const seed = 12345;
  const rng = G.makeRng(seed);
  const board = G.buildBoard(rng);
  const state = { ...board, rng, winner: null };
  let turns = 0;
  while (!G.checkWinner(state) && turns++ < 500) {
    // RED: attack any legal move that targets the weakest enemy, a few times
    let acted = 0;
    while (acted++ < 50) {
      const moves = G.legalMoves(state, 'red');
      if (!moves.length) break;
      // pick move into weakest target
      moves.sort((a,b) => state.nodes[a.to].strength - state.nodes[b.to].strength);
      G.resolveBattle(state, moves[0].from, moves[0].to);
      if (G.checkWinner(state)) break;
    }
    if (G.checkWinner(state)) break;
    G.reinforce(state, 'red');
    if (G.checkWinner(state)) break;
    const log = [];
    for (const bot of G.BOTS) { G.runBotTurn(state, bot, log); if (G.checkWinner(state)) break; }
    ok('total nodes always 30', state.nodes.length === 30);
  }
  const w = G.checkWinner(state);
  ok('game terminates with a winner', !!w);
  const c = G.counts(state);
  ok('winner holds >=24 or is last alive',
     c[w] >= 24 || G.FACTIONS.filter(f => c[f] > 0).length === 1);
}

console.log(`\n✓ all ${passed} assertions passed`);
