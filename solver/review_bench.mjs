// Full-game review cost and budget sensitivity on the actual WASM worker.
// node solver/review_bench.mjs [seeds=11,17,23] [workers=4] [referenceMax=96000]
// The larger search is a stability reference, not ground truth about optimal play.
import { Worker, isMainThread, parentPort, MessageChannel } from 'node:worker_threads';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tierOf } from '../public/review.js';

if (!isMainThread) {
  globalThis.self = globalThis;
  globalThis.MessageChannel ??= MessageChannel;
  self.postMessage = m => parentPort.postMessage(m);
  await import('../public/engine.worker.js');
  parentPort.on('message', data => self.onmessage({ data }));
} else {
  const seeds = (process.argv[2] || '11,17,23').split(',').map(Number);
  const workers = Number(process.argv[3] || 4);
  const referenceMax = Number(process.argv[4] || 96000);
  const threads = [];
  let profile = {};
  const makeEngine = () => {
    const w = new Worker(new URL(import.meta.url)); threads.push(w);
    const pending = new Map(); let next = 0;
    w.on('message', m => {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p.resolve(m.result); }
    });
    w.on('error', err => { for (const p of pending.values()) p.reject(err); pending.clear(); });
    return async (path, method = 'GET', body = null) => {
      const kind = path.endsWith('/search') ? 'search' : 'replay';
      const start = performance.now();
      const result = await new Promise((resolve, reject) => {
        const id = ++next; pending.set(id, { resolve, reject });
        w.postMessage({ id, path, method, body });
      });
      const p = profile[kind] ||= { calls: 0, ms: 0, sims: 0 };
      p.calls++; p.ms += performance.now() - start; p.sims += result.sims || 0;
      if (result.error) throw new Error(result.error);
      return result;
    };
  };
  try {
    const rounds = [], play = makeEngine();
    for (const seed of seeds) {
      let s = await play('/api/game', 'POST', { seed });
      const moves = [];
      while (!s.over && moves.length < 2000) {
        const r = await play(`/api/game/${s.id}/search`, 'POST', { sims: 2000, maxSims: 4000 });
        // Include a few suboptimal human-like choices, rather than only best moves.
        const b = seed === seeds[0] || moves.length % 3 !== 1 ? r.best
          : seed % 3 === 0 ? r.all.find(m => m.action === -1)
          : seed % 3 === 1 ? r.all[(seed + moves.length * 7) % r.all.length]
          : r.all[2] || r.best;
        const mv = !b || b.action === -1 ? { e: 1 } : { a: [b.from, b.to] };
        moves.push(mv);
        s = mv.e ? await play(`/api/game/${s.id}/end-turn`, 'POST')
          : await play(`/api/game/${s.id}/attack`, 'POST', { from: mv.a[0], to: mv.a[1] });
      }
      if (!s.over) throw new Error(`Seed ${seed} did not finish`);
      rounds.push({ seed, rules: s.rules, you: { moves } });
      console.log(`Recorded seed ${seed}: ${moves.length} decisions, ${s.youWon ? 'win' : 'loss'}`);
    }
    const source = await readFile(new URL('../public/review.js', import.meta.url), 'utf8');
    const runs = {};
    for (const [name, limits] of [['current', [16000, 24000]], ['half', [8000, 12000]],
      ['reference', [referenceMax, referenceMax]]]) {
      const poolStart = threads.length;
      const module = await import('data:text/javascript;base64,' + Buffer.from(source.replace(
        'REVIEW_SIMS = 16000, REVIEW_MAX = 24000',
        `REVIEW_SIMS = ${limits[0]}, REVIEW_MAX = ${limits[1]}`)).toString('base64'));
      const reviewer = module.createReviewer(makeEngine, workers);
      profile = {};
      const start = performance.now(), reviews = [];
      for (const r of rounds) {
        reviews.push(await reviewer.grade(r, () => {}));
        console.log(`${name}: seed ${r.seed} complete`);
      }
      runs[name] = { ms: performance.now() - start, profile, reviews };
      console.log(`${name}: ${(runs[name].ms / 1000).toFixed(2)}s, ${JSON.stringify(profile)}`);
      await Promise.all(threads.splice(poolStart).map(t => t.terminate()));
    }
    const compare = (name, ref) => {
      const deltas = []; let tiers = 0, dead = 0, n = 0;
      runs[name].reviews.forEach((rv, i) => rv.moves.forEach((m, k) => {
        const t = runs[ref].reviews[i].moves[k]; n++;
        if (m.dead !== t.dead) dead++;
        if (m.gap != null && t.gap != null && (!m.dead || !t.dead)) {
          deltas.push(Math.abs(m.gap - t.gap));
          if (tierOf(m.gap).k !== tierOf(t.gap).k) tiers++;
        }
      }));
      deltas.sort((a, b) => a - b);
      return { decisions: n, liveEither: deltas.length, tierChanges: tiers, deadChanges: dead,
        meanGapDelta: deltas.reduce((a, b) => a + b, 0) / deltas.length,
        p95GapDelta: deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * .95))],
        maxGapDelta: deltas.at(-1) };
    };
    const comparisons = { halfVsCurrent: compare('half', 'current'),
      currentVsReference: compare('current', 'reference'), halfVsReference: compare('half', 'reference') };
    console.log(JSON.stringify(comparisons, null, 2));
    await mkdir('/tmp/nw-review-perf', { recursive: true });
    const output = `/tmp/nw-review-perf/benchmark-${seeds.length}.json`;
    await writeFile(output, JSON.stringify({ seeds, workers, rounds, runs, comparisons }, null, 2));
    console.log(`Details: ${output}`);
  } finally { await Promise.all(threads.map(t => t.terminate())); }
}
