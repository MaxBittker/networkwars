// Gate for public/review.js — the head-to-head page's decision scorer. Hosts
// engine.worker.js in real worker threads (one per pool worker, as the browser
// does) and checks that the PARALLEL review of a recorded game is bit-identical
// to a serial one-worker review of the same game: same Qs, gaps, labels, dead
// flags, and no null holes left behind. Also reports the wall-clock speedup.
//
//   node solver/review_gate.mjs [seed] [workers] [baseline-review.mjs]
import { Worker, isMainThread, parentPort, MessageChannel } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const WK = new URL('../public/engine.worker.js', import.meta.url);
if (!isMainThread) {
  globalThis.self = globalThis;
  globalThis.MessageChannel ??= MessageChannel;
  self.postMessage = (m) => parentPort.postMessage(m);
  await import(WK);
  parentPort.on('message', (d) => self.onmessage({ data: d }));
} else {
  const { createReviewer } = await import('../public/review.js');
  const { createReplayInspector } = await import('../public/replay.js');
  const baselineReviewer = process.argv[4]
    ? (await import(pathToFileURL(process.argv[4]))).createReviewer : createReviewer;
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
  const cleanView = ({ id, log, events, ...v }) => v;
  const views = [cleanView(s)], moves = [];
  for (let g = 0; g < 2000 && !s.over; g++) {
    const r = await play(`/api/game/${s.id}/search`, 'POST', { sims: 2000, maxSims: 4000 });
    const b = r.best;
    if (!b || b.action === -1) { moves.push({ e: 1 }); s = await play(`/api/game/${s.id}/end-turn`, 'POST'); }
    else { moves.push({ a: [b.from, b.to] }); s = await play(`/api/game/${s.id}/attack`, 'POST', { from: b.from, to: b.to }); }
    views.push(cleanView(s));
  }
  const round = { seed, rules: s.rules, you: { moves } };

  const run = async (n, create = createReviewer) => {
    const rv = create(makeEngine, n);
    let partials = 0, holesSeen = false, orderOk = true;
    const t0 = performance.now();
    const out = await rv.grade(round, (p) => {
      partials++;
      if (!p.partial || p.partial.done !== p.moves.filter(Boolean).length) orderOk = false;
      if (p.moves.includes(null)) holesSeen = true;
    });
    return { out, ms: performance.now() - t0, partials, holesSeen, orderOk };
  };
  const ser = await run(1, baselineReviewer);
  const par = await run(NW);
  let fails = 0;
  const fail = (m) => { fails++; console.error('  FAIL: ' + m); };
  const gradesOnly = ({ version, source, ...out }) => out;
  if (JSON.stringify(gradesOnly(ser.out)) !== JSON.stringify(gradesOnly(par.out))) fail('parallel review differs from serial');
  if (par.out.moves.length !== moves.length || par.out.moves.includes(null)) fail('review has holes');
  if (par.out.partial) fail('completed review still marked partial');
  if (par.partials !== moves.length) fail(`expected ${moves.length} partial callbacks, got ${par.partials}`);
  if (!par.orderOk) fail('partial.done disagrees with the scored count');
  if (NW > 1 && !par.holesSeen) fail('parallel review never reported an in-flight hole');
  console.log(`seed ${seed}: ${moves.length} decisions, ${ser.out.nLive} live; serial ${(ser.ms / 1000).toFixed(1)}s, `
    + `x${NW} ${(par.ms / 1000).toFixed(1)}s (${(ser.ms / par.ms).toFixed(1)}x); identical=${fails === 0}`);

  // Simulate a persisted partial review with out-of-order holes, then a reload.
  const checkpoint = structuredClone(par.out);
  checkpoint.moves = checkpoint.moves.map((m, k) => k % 3 === 0 ? null : m);
  checkpoint.partial = { done: checkpoint.moves.filter(Boolean).length, total: moves.length };
  let searches = 0;
  const countedEngine = () => {
    const api = makeEngine();
    return (path, ...args) => { if (path.endsWith('/search')) searches++; return api(path, ...args); };
  };
  const resumed = createReviewer(countedEngine, NW);
  const resumeStart = performance.now();
  const restored = await resumed.grade({ ...round, you: { moves, review: checkpoint } });
  assert.deepEqual(restored, par.out);
  assert.equal(searches, Math.ceil(moves.length / 3));
  console.log(`Resume: ${searches}/${moves.length} searches, ${((performance.now() - resumeStart)/1000).toFixed(2)}s; exact grades`);
  searches = 0;
  assert.deepEqual(await resumed.grade({ ...round, you: { moves, review: restored } }), par.out);
  assert.equal(searches, 0, 'completed cache must not search again');

  // Compare every batch-replayed board to the animated route, including the
  // terminal board: this checks subsequent dice consumption as well as ownership.
  const replay = await play('/api/replay', 'POST', { seed, moves });
  assert.deepEqual(replay.frames.map(cleanView), views);
  const liveAfterReplay = await play(`/api/game/${s.id}`);
  assert.deepEqual(cleanView(liveAfterReplay), views.at(-1), 'replay mutated a saved game');
  let live = await play('/api/game', 'POST', { seed: seed + 100 });
  const expectedNext = cleanView(await play(`/api/game/${live.id}/end-turn`, 'POST'));
  live = await play('/api/game', 'POST', { seed: seed + 100 });
  await play('/api/replay', 'POST', { seed, moves });
  assert.deepEqual(cleanView(await play(`/api/game/${live.id}/end-turn`, 'POST')), expectedNext,
    'inspector changed live game topology or dice');
  await play(`/api/game/${live.id}`, 'DELETE');
  assert.equal((await play(`/api/game/${live.id}`))._status, 404);

  const oldInspectStart = performance.now();
  let oldCalls = 0;
  for (let k = 0; k < moves.length; k++) {
    let v = await play('/api/game', 'POST', { seed }); oldCalls++;
    for (const mv of moves.slice(0, k)) {
      v = mv.e ? await play(`/api/game/${v.id}/end-turn`, 'POST')
        : await play(`/api/game/${v.id}/attack`, 'POST', { from: mv.a[0], to: mv.a[1] });
      oldCalls++;
    }
    assert.deepEqual(cleanView(v), views[k]);
  }
  const oldMs = performance.now() - oldInspectStart;
  let replayCalls = 0;
  const inspector = createReplayInspector((...args) => { replayCalls++; return play(...args); });
  const inspectStart = performance.now();
  const inspected = await Promise.all(moves.map((_, k) => inspector(seed, moves, k)));
  assert.deepEqual(inspected.map(cleanView), views.slice(0, -1));
  for (let k = moves.length - 1; k >= 0; k--) assert.deepEqual(cleanView(await inspector(seed, moves, k)), views[k]);
  assert.equal(replayCalls, 1, 'forward/backward/concurrent selections must share one replay');
  console.log(`Inspector: ${moves.length * 2} selections in ${(performance.now()-inspectStart).toFixed(1)}ms, one replay request; exact boards`);
  console.log(`Previous inspector: ${moves.length} forward selections in ${oldMs.toFixed(1)}ms, ${oldCalls} requests`);
  for (const t of threads) t.terminate();
  console.log(fails ? `FAIL (${fails})` : 'PASS');
  process.exit(fails ? 1 : 0);
}
