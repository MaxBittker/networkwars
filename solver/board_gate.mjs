// Replay contract tests: actual engine events, a virtual animation clock, no DOM.
// These check every casualty and boundary, not pixels (visually checked in browser).
// Run: node solver/board_gate.mjs
import assert from 'node:assert/strict';
import { Board, TIMING, NODE_PALETTE } from '../public/board.js';
import { loadEngine, FACTIONS } from '../public/fastnw.js';

const E = await loadEngine();
const board = new Board({ getContext: () => ({}) }, {});
let frames = [], callbacks = [];
board.draw = () => {
  frames.push({ nodes: structuredClone(board.animBoard),
    overrides: new Map(board.overrides), battle: board.battle && { ...board.battle },
    reinforce: board.reinforceFlash && new Set(board.reinforceFlash) });
};
board._beat = async (ms, frame = () => {}) => { frame(0); board.draw(); frame(1); board.draw(); };
board.onReplay = (f, nodes) => callbacks.push({ f, nodes: structuredClone(nodes) });

let captures = 0, repels = 0;
for (let seed = 1; seed <= 30; seed++) {
  const g = E.newGame(seed);
  const move = E.legalMoves(g.owner, g.strength, g.adj)[0];
  if (!move) continue;
  const [from, to] = move;
  const nodes = Array.from(g.owner, (f, id) => ({ id, x: g.x[id], y: g.y[id], owner: FACTIONS[f], strength: g.strength[id] }));
  const initial = structuredClone(nodes);
  E.useMb32(g.mb);
  const { flips, meta } = E.attackLogged(g.owner, g.strength, from, to);
  const event = { type: 'attack', attacker: 'red', from, to, flips, ...meta };
  board.setView({ nodes, links: g.links, legalMoves: [] });
  frames = []; callbacks = [];
  await board.animateBattle(event);
  assert.deepEqual(nodes, initial, 'animation mutated authoritative state');
  let a = event.fromStart, d = event.toStart;
  for (let i = 0; i < flips.length; i++) {
    flips[i] === 'd' ? d-- : a--;
    const frame = frames[2 + i * 2];
    assert.equal(frame.overrides.get(from).strength, a);
    assert.equal(frame.overrides.get(to).strength, Math.max(0, d));
  }
  assert.equal(callbacks[0].nodes[from].strength, g.strength[from]);
  assert.equal(callbacks[0].nodes[to].strength, g.strength[to]);
  assert.equal(callbacks[0].nodes[to].owner, FACTIONS[g.owner[to]]);
  event.captured ? captures++ : repels++;
  assert.equal(board.animBoard, null);
  assert.equal(board.battle, null);
  assert.equal(board.overrides.size, 0);

  // A bot uses the same battle path inside a whole-turn replay, followed by
  // reinforcement. Header counts must only change when the capture commits.
  frames = []; callbacks = [];
  const rein = { type: 'reinforce', faction: 'red', changes: [{ id: from, to: 7 }] };
  await board.animateEndTurn({ events: [event, rein] });
  assert.equal(callbacks[0].nodes[to].owner, initial[to].owner);
  assert.equal(callbacks[1].nodes[to].owner, FACTIONS[g.owner[to]]);
  assert(frames.some(f => f.reinforce?.has(from) && f.nodes[from].strength === 7));
  assert.deepEqual(nodes, initial);
  assert.equal(board.animBoard, null);
}
assert(captures && repels, 'must exercise captures and repels');

// Skipping mid-turn or a failing observer must leave no transient decoration or
// mutation behind; the caller can immediately adopt the authoritative final view.
const original = structuredClone(board.state);
board.abort = false;
board._beat = async () => { board.abort = true; };
await board.animateEndTurn({ events: [{ type: 'reinforce', faction: 'red', changes: [{ id: 0, to: 99 }] }] });
assert.deepEqual(board.state, original);
assert.equal(board.animBoard, null);
assert.equal(board.reinforceFlash, null);
board.abort = false;
board.onReplay = () => { throw new Error('observer failure'); };
await assert.rejects(board.animateEndTurn({ events: [{ type: 'reinforce', faction: 'red', changes: [] }] }), /observer failure/);
assert.equal(board.animBoard, null);
assert.equal(board.overrides.size, 0);

// Compact layouts must clear the overlay with the entire top node, not its center.
globalThis.window = { devicePixelRatio: 2 };
const compact = new Board({ getContext: () => ({ setTransform() {} }) },
  { getBoundingClientRect: () => ({ width: 320, height: 402 }) });
compact.draw = () => {};
compact.topInset = 68;
compact.setView(structuredClone(board.state)); compact.resize();
assert(Math.min(...compact.positions.map(p => p.y)) - compact.layout.r >= compact.topInset);
const shifted = structuredClone(compact.state); shifted.nodes[0].x += .5;
compact.setView(shifted);
assert.deepEqual(compact.positions[0], compact.nodePos(shifted.nodes[0]));
delete globalThis.window;

// The moving arrow must stay on the attack vector in every compass direction,
// advance toward the defender, and keep both tip and tail between the node rims.
let triangle = [];
const arrow = new Board({ getContext: () => ({
  beginPath() { triangle = []; }, moveTo(x,y) { triangle.push({x,y}); },
  lineTo(x,y) { triangle.push({x,y}); }, closePath() {}, fill() {},
}) }, {});
arrow.layout.r = 20;
for (const [x, y] of [[90,0], [90,90], [0,90], [-90,90], [-90,0], [-90,-90], [0,-90], [90,-90]]) {
  const length = Math.hypot(x,y), ux = x/length, uy = y/length;
  let last = 0;
  for (const progress of [0, .25, .5, .75, 1]) {
    arrow._drawArrow({x:0,y:0}, {x,y}, '#fff', progress);
    const [tip, left, right] = triangle;
    const tail = { x:(left.x+right.x)/2, y:(left.y+right.y)/2 };
    const along = tip.x*ux + tip.y*uy;
    assert(Math.abs(tip.x*uy - tip.y*ux) < 1e-10);
    assert(Math.abs(tail.x*uy - tail.y*ux) < 1e-10);
    assert(along > last && along <= length - 21 + 1e-10);
    assert(tail.x*ux + tail.y*uy >= 21 - 1e-10);
    last = along;
  }
}

// Glow frames must not change sprite bounds or compress/scale the numerals.
let images = [];
const paint = new Board({ getContext: () => ({
  clearRect() {}, setLineDash() {}, drawImage(...args) { images.push(args.slice(1)); },
  save() {}, restore() {}, translate() {}, fillText() {},
  scale() { assert.fail('node drawing must not scale'); },
}) }, {});
paint._skin = () => ({ cv: {}, size: 100 });
paint._drawArrow = () => {};
paint.setView({ nodes:[{id:0,x:0,y:0,owner:'red',strength:12}], links:[], legalMoves:[] });
paint.battle = { from:0, to:0 };
for (const light of [0,.4,.78]) for (const pulse of [0,.5,1]) {
  paint.light = light; paint.pulse = pulse; paint.flashId = 0;
  images = []; paint.draw();
  for (const bounds of images) assert.deepEqual(bounds, [-50,-50,100,100]);
  assert(!paint.ctx.font.includes('Narrow'));
}

// The defender keeps its own fill/ink while sharing the attacker's outer glow.
// Reinforcement uses the receiving faction's saturated treatment, not attacker fill.
let skinCalls = [], inks = [];
paint._skin = (owner, mode = 'idle', glow = owner) => {
  skinCalls.push([owner,mode,glow]); return { cv:{}, size:100 };
};
paint.ctx.fillText = function () { inks.push(this.fillStyle); };
paint.setView({ nodes:[
  {id:0,x:0,y:0,owner:'red',strength:6},
  {id:1,x:100,y:0,owner:'blue',strength:3},
  {id:2,x:200,y:0,owner:'green',strength:8},
], links:[], legalMoves:[] });
paint.battle = { from:0,to:1 }; paint.reinforceFlash = new Set([2]);
paint.light = 1; paint.pulse = 0; paint.draw();
assert(skinCalls.some(c => c.join(':') === 'red:attacker:red'));
assert(skinCalls.some(c => c.join(':') === 'blue:defender:red'));
assert(skinCalls.some(c => c.join(':') === 'green:reinforce:green'));
assert.deepEqual(inks, ['red','blue','green'].map(f => NODE_PALETTE[f].ink));

// Real clock: Instant and abort inside a frame must promptly release the promise.
let now = 0, nextFrame;
const realPerformance = globalThis.performance;
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = fn => { nextFrame = fn; return 1; };
globalThis.cancelAnimationFrame = () => {};
board._beat = Board.prototype._beat;
for (const stop of ['instant', 'abort']) {
  board.abort = false; board.speed = 1;
  const p = board._beat(TIMING.reinforce);
  if (stop === 'instant') board.speed = 0; else board.abort = true;
  now += 16; nextFrame(); await p;
}
// Fast really shortens the beat; no frozen speed snapshot at replay start.
for (const speed of [1, .25, 2]) {
  board.abort = false; board.speed = speed;
  board.battle = { elapsed: 0 };
  let done = false, count = 0;
  const p = board._beat(100).then(() => { done = true; });
  while (!done) {
    now += 25; nextFrame(); await Promise.resolve(); await Promise.resolve();
    count++; assert(count < 15);
  }
  await p;
  assert.equal(count, 4 * speed);
  assert.equal(board.battle.elapsed, 100);
  board.battle = null;
}
globalThis.performance = realPerformance;
console.log(`BOARD-GATE PASS: ${captures} captures, ${repels} repels, turn/reinforcement boundaries, speed and skip`);
