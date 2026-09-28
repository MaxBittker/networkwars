// Gate for engine.worker.js's between-chunk yield and its liveness reporting.
// On iOS, WebKit brokers every MessagePort through its networking process; when
// iOS suspends or kills that process, ports stop delivering with no error. The
// worker's search used to yield through a MessageChannel and then hung forever,
// wedging the AI and review workers for the rest of the session (found via the
// page's stall reports on a phone). The worker now yields on timers only; this
// makes MessageChannel unusable before loading it, so any reintroduction fails.
// It also checks what the page's stall reports rely on: a `beat` per finished
// search chunk, and a `ping` answered outside the request queue mid-search.
//
//   node solver/yield_gate.mjs
import assert from 'node:assert/strict';

globalThis.MessageChannel = class {
  constructor() { throw new Error('engine.worker.js must not use MessageChannel (iOS drops ports)'); }
};
globalThis.self = globalThis;
const pending = new Map(), beats = [], pongs = [];
let nextReq = 0;
self.postMessage = (msg) => {
  if (msg.type === 'beat') { beats.push(msg.sims); return; }
  if (msg.type === 'pong') { pongs.push(msg.probe); return; }
  const r = pending.get(msg.id);
  if (r) { pending.delete(msg.id); r(msg.result); }
};
await import('../public/engine.worker.js');
function api(path, method = 'GET', body = null) {
  const id = String(++nextReq);
  return new Promise((res) => { pending.set(id, res); self.onmessage({ data: { id, path, method, body } }); });
}
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(new Error(`${what}: no reply after ${ms} ms`)), ms).unref())]);

const game = await api('/api/game', 'POST', { seed: 11 });
const search = { sims: 6000, maxSims: 30000 };
const first = within(api(`/api/game/${game.id}/search`, 'POST', search), 60000, 'search');
setTimeout(() => self.onmessage({ data: { ping: 1 } }), 0);   // lands between chunks
const out = await first;
assert.equal(out.done, true, 'the search runs to its own stop');
assert.ok(beats.length >= 2, 'one beat per finished chunk');
assert.equal(beats.at(-1), out.sims, 'the last beat is the final sim count');
assert.equal(pongs.length, 1, 'a ping is answered mid-search, outside the queue');
const p = pongs[0];
assert.equal(p.path, `/api/game/${game.id}/search`);
assert.equal(p.pumping, true);
assert.ok(p.chunks >= 1 && p.lastChunkMs >= 0 && p.busyMs >= 0, JSON.stringify(p));
const again = await within(api(`/api/game/${game.id}/search`, 'POST', search), 60000, 'repeat search');
assert.deepEqual(again.all, out.all, 'timer-yield searches are deterministic');
self.onmessage({ data: { ping: 1 } });
assert.equal(pongs[1].path, null, 'an idle worker reports no request in progress');
console.log(`PASS: no MessageChannel in the worker; ${beats.length} beats, mid-search ping `
  + `answered (${p.chunks} chunks in), repeat search identical (${out.sims} sims)`);
process.exit(0);
