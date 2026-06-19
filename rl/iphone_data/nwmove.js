'use strict';
// Bridge: parsed screenshot state -> ONE best RED move via mcts.js.
//
// Reads a state JSON (from parse.py) on argv[2]. Reconstructs adjacency from grid
// coords (the engine's lattice == 8-connectivity among surviving cells), builds the
// sim api, and runs the mcts policy until it makes its FIRST attack (which we capture
// and abort) or decides to stop. Prints JSON:
//   {"action":"attack","from":id,"to":id,"fromPx":[x,y],"toPx":[x,y]}  or  {"action":"stop"}
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const G = require(path.join(ROOT, 'game'));
const { makeMcts } = require(path.join(ROOT, 'mcts'));

const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const rollout = process.argv[3] || 'strong';

const nodes = state.nodes.map(n => ({
  id: n.id, x: n.col, y: n.row, owner: n.owner, strength: n.strength,
}));
const px = state.nodes.map(n => [n.px, n.py]);

// 8-connectivity among surviving grid cells == the engine's lattice adjacency.
const adj = nodes.map(() => []);
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    if (Math.abs(nodes[i].x - nodes[j].x) <= 1 && Math.abs(nodes[i].y - nodes[j].y) <= 1) {
      adj[i].push(j); adj[j].push(i);
    }
  }
}

const live = { nodes, adj, rng: null };
const api = {
  faction: 'red',
  get nodes() { return nodes; },
  node: (id) => nodes[id],
  neighbors: (id) => adj[id],
  counts: () => G.counts(live),
  legalMoves: () => G.legalMoves(live, 'red'),
  attack(from, to) { const e = new Error('first-move'); e.move = { from, to }; throw e; },
  rng: Math.random,
};

const policy = makeMcts({ rollout });
try {
  policy(api);
  process.stdout.write(JSON.stringify({ action: 'stop' }) + '\n');
} catch (e) {
  if (e && e.move) {
    const { from, to } = e.move;
    process.stdout.write(JSON.stringify({
      action: 'attack', from, to, fromPx: px[from], toPx: px[to],
    }) + '\n');
  } else {
    throw e;
  }
}
