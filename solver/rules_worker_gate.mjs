// Gameplay boundaries + old/new saved-game replay compatibility in the real worker.
// Run: node solver/rules_worker_gate.mjs
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createReplayInspector } from '../public/replay.js';
globalThis.self = globalThis;
globalThis.MessageChannel ??= MessageChannel;
const pending = new Map();
let sequence = 0;
self.postMessage = m => { const done = pending.get(m.id); pending.delete(m.id); done(m.result); };
await import('../public/engine.worker.js');
function api(path, method = 'GET', body = null) {
  const id = ++sequence;
  return new Promise(done => { pending.set(id, done); self.onmessage({data:{id,path,method,body}}); });
}
const clean = ({ id, events, log, ...v }) => v;
const load = nodes => api('/load-board','POST',{nodes,mb:19});
const node = (id,x,owner,strength=1) => ({id,x,y:0,owner,strength});

const board = [node(0,0,'red',4),node(1,1,'green',3),node(2,2,'red'),
  node(3,3,'yellow'),node(4,4,'red',3),node(5,5,'red',2)];
let g = await load(board);
assert(!g.error && !g.over);
const before = clean(g);
for (const move of [{}, {from:null,to:1}, {from:'0',to:1}, {from:0.5,to:1},
  {from:-1,to:1},{from:0,to:6},{from:0,to:0},{from:0,to:3},
  {from:1,to:0},{from:2,to:1},{from:4,to:5}]) {
  assert((await api(`/api/game/${g.id}/attack`,'POST',move)).error, JSON.stringify(move));
  assert.deepEqual(clean(await api(`/api/game/${g.id}`)),before);
}
const after = await api(`/api/game/${g.id}/attack`,'POST',{from:0,to:1});
const control = await load(board);
const expected = await api(`/api/game/${control.id}/attack`,'POST',{from:0,to:1});
assert.deepEqual(clean(after),clean(expected),'rejected moves consumed dice');
assert.deepEqual(after.log,expected.log);

for (const nodes of [[],[...board,board[0]],board.map(n=>({...n,id:0})),
  board.map(n=>({...n,x:0})),board.map(n=>({...n,owner:'unknown'})),
  board.map(n=>({...n,strength:-1}))]) assert((await load(nodes)).error);

for (const nodes of [Array.from({length:30},(_,i)=>node(i,i,i<24?'red':'green',3)),
  [node(0,0,'green',3),node(1,1,'yellow',3)]]) {
  const ended = await load(nodes);
  assert(ended.over && ended.legalMoves.length === 0);
  assert((await api(`/api/game/${ended.id}/end-turn`,'POST')).error);
  assert((await api(`/api/game/${ended.id}/attack`,'POST',{from:0,to:1})).error);
  assert.deepEqual(clean(await api(`/api/game/${ended.id}`)),clean(ended));
}

// Both versions use identical animated/batch-replay game rules. Version 1 is
// the default for existing saved rounds; version 2 is the default for new games.
for (const rules of [1,2]) {
  const seed = 11, moves = [];
  let s = await api('/api/game','POST',{seed,rules});
  const views = [clean(s)];
  for (let i = 0; i < 1000 && !s.over; i++) {
    const move = s.legalMoves[0];
    moves.push(move ? {a:[move.from,move.to]} : {e:1});
    s = move ? await api(`/api/game/${s.id}/attack`,'POST',move)
      : await api(`/api/game/${s.id}/end-turn`,'POST');
    assert(!s.error);
    views.push(clean(s));
  }
  assert(s.over);
  const replay = await api('/api/replay','POST',{seed,rules,moves});
  assert.deepEqual(replay.frames.map(clean),views);
  const inspector = createReplayInspector(api);
  assert.deepEqual(clean(await inspector(seed,moves,0,rules)),views[0]);
  assert.deepEqual(clean(await inspector(seed,moves,moves.length-1,rules)),views.at(-2));
  assert((await api(`/api/game/${s.id}/end-turn`,'POST')).error);
  assert((await api('/api/replay','POST',{seed,rules,moves:[{a:[0,0]}]})).error);
  assert((await api('/api/replay','POST',{seed,rules,moves:[...moves,{e:1}]})).error);
}
const legacy = await api('/api/game','POST',{seed:42,rules:1});
const current = await api('/api/game','POST',{seed:42});
assert.equal(current.rules,2);
assert.notDeepEqual(current.nodes,legacy.nodes);
assert((await api('/api/game','POST',{seed:42,rules:99})).error);
console.log('RULES-WORKER-GATE: PASS (illegal moves, terminal boards, imports, both replay versions)');
process.exit(0);
