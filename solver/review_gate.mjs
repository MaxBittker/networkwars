// Gate for public/review.js — the head-to-head page's decision scorer. Hosts
// engine.worker.js in real worker threads (one per pool worker, as the browser
// does) and checks that the PARALLEL review of a recorded game is bit-identical
// to a serial one-worker review of the same game: same Qs, gaps, labels, dead
// flags, and no null holes left behind. Also reports the wall-clock speedup.
//
//   node solver/review_gate.mjs [seed] [workers]
import { Worker, isMainThread, parentPort, MessageChannel } from 'node:worker_threads';

const WK = new URL('../public/engine.worker.js', import.meta.url);
if (!isMainThread) {
  globalThis.self = globalThis;
  globalThis.MessageChannel ??= MessageChannel;
  self.postMessage = (m) => parentPort.postMessage(m);
  await import(WK);
  parentPort.on('message', (d) => self.onmessage({ data: d }));
} else {
  const { createReviewer } = await import('../public/review.js');
  const threads = [];
  // Same contract as index.html's makeEngine: a request fn over a fresh worker.
  const makeEngine = () => {
    const w = new Worker(new URL(import.meta.url)); threads.push(w);
    const pend = new Map(); let id = 0;
    w.on('message', (m) => { const r = pend.get(m.id); if (r) { pend.delete(m.id); r(m.result); } });
    return (path, method = 'GET', body = null) => new Promise(res => {
      const k = ++id; pend.set(k, res); w.postMessage({ id: k, path, method, body }); });
  };
  const seed = Number(process.argv[2] || 11), NW = Number(process.argv[3] || 4);

  // Record a game the way the page does (a light search stands in for the human).
  const play = makeEngine();
  let s = await play('/api/game', 'POST', { seed });
  const moves = [];
  for (let g = 0; g < 2000 && !s.over; g++) {
    const r = await play(`/api/game/${s.id}/search`, 'POST', { sims: 2000, maxSims: 4000 });
    const b = r.best;
    if (!b || b.action === -1) { moves.push({ e: 1 }); s = await play(`/api/game/${s.id}/end-turn`, 'POST'); }
    else { moves.push({ a: [b.from, b.to] }); s = await play(`/api/game/${s.id}/attack`, 'POST', { from: b.from, to: b.to }); }
  }
  const round = { seed, you: { moves } };

  const run = async (n) => {
    const rv = createReviewer(makeEngine, n);
    let partials = 0, holesSeen = false, orderOk = true;
    const t0 = performance.now();
    const out = await rv.grade(round, (p) => {
      partials++;
      if (!p.partial || p.partial.done !== p.moves.filter(Boolean).length) orderOk = false;
      if (p.moves.includes(null)) holesSeen = true;
    });
    return { out, ms: performance.now() - t0, partials, holesSeen, orderOk };
  };
  const ser = await run(1);
  const par = await run(NW);
  let fails = 0;
  const fail = (m) => { fails++; console.error('  FAIL: ' + m); };
  if (JSON.stringify(ser.out) !== JSON.stringify(par.out)) fail('parallel review differs from serial');
  if (par.out.moves.length !== moves.length || par.out.moves.includes(null)) fail('review has holes');
  if (par.out.partial) fail('completed review still marked partial');
  if (par.partials !== moves.length) fail(`expected ${moves.length} partial callbacks, got ${par.partials}`);
  if (!par.orderOk) fail('partial.done disagrees with the scored count');
  if (NW > 1 && !par.holesSeen) fail('parallel review never reported an in-flight hole');
  console.log(`seed ${seed}: ${moves.length} decisions, ${ser.out.nLive} live; serial ${(ser.ms / 1000).toFixed(1)}s, `
    + `x${NW} ${(par.ms / 1000).toFixed(1)}s (${(ser.ms / par.ms).toFixed(1)}x); identical=${fails === 0}`);
  for (const t of threads) t.terminate();
  console.log(fails ? `FAIL (${fails})` : 'PASS');
  process.exit(fails ? 1 : 0);
}
