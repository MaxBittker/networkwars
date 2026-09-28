// Gate for engine.worker.js's between-chunk yield surviving a dead MessagePort.
// On iOS, WebKit brokers every MessagePort through its networking process; when
// iOS suspends or kills that process, ports stop delivering with no error. The
// worker's search used to await a port yield forever, wedging the AI and review
// workers for the rest of the session (found via the page's stall reports on a
// phone). This hosts the worker in node, kills its channel mid-session, and
// asserts a search still finishes on the timer fallback, bit-identical to the
// same search with a working channel.
//
//   node solver/yield_gate.mjs
import assert from 'node:assert/strict';

// A MessageChannel whose deliveries can be switched off, like a port whose broker died.
let portsDead = false;
const Native = globalThis.MessageChannel;
globalThis.MessageChannel = class {
  constructor() {
    const ch = new Native();
    this.port1 = ch.port1;
    this.port2 = { postMessage: (m) => { if (!portsDead) ch.port2.postMessage(m); } };
    ch.port1.unref?.();
  }
};
globalThis.self = globalThis;
const pending = new Map();
let nextReq = 0;
self.postMessage = (msg) => {
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
const live = await within(api(`/api/game/${game.id}/search`, 'POST', search), 60000, 'live-port search');
assert.equal(live.done, true);
assert.equal(live.yield, 'port', 'a working channel keeps the fast port yield');

portsDead = true;
const t0 = performance.now();
const dead = await within(api(`/api/game/${game.id}/search`, 'POST', search), 60000, 'dead-port search');
assert.equal(dead.done, true, 'the search runs to its own stop, not an abort');
assert.equal(dead.yield, 'timer', 'a dead channel falls back to timer yields');
assert.deepEqual(dead.all, live.all, 'yield mode never changes the search result');
assert.equal(dead.sims, live.sims);
const again = await within(api(`/api/game/${game.id}/search`, 'POST', search), 60000, 'timer-mode search');
assert.deepEqual(again.all, live.all);
console.log(`PASS: dead MessagePort -> timer yields (${(performance.now() - t0).toFixed(0)} ms for two`
  + ` searches), results bit-identical to the live-port search (${live.sims} sims)`);
process.exit(0);
