// End-to-end gate for public/engine.worker.js — the game/orchestration layer the two
// pages talk to. Emulates just enough of a Web Worker (self.onmessage /
// self.postMessage) to import it in node and drive the SAME /api/game/* request
// sequence index.html and head-to-head.html issue, so the routes are exercised as
// shipped rather than only through fastnw.js.
//
// What it asserts, per seed: a game plays to a real terminal state; the sweep-up
// certificate is never handed a finished game and never fires on an opening; and an
// accepted sweep either finishes the game or bails out through the re-check — the
// loop the pages run, including its abort path.
//
//   node solver/worker_gate.mjs [nseeds]
import { MessageChannel } from 'node:worker_threads';

globalThis.self = globalThis;
globalThis.MessageChannel ??= MessageChannel;

const pending = new Map();
let nextReq = 0;
self.postMessage = (msg) => {
  const r = pending.get(msg.id);
  if (r) { pending.delete(msg.id); r(msg.result); }
};
await import('../public/engine.worker.js');

const timings = [];               // ms per full-strength sweep certificate (UI cost)
function api(path, method = 'GET', body = null) {
  const id = String(++nextReq);
  return new Promise((res) => { pending.set(id, res); self.onmessage({ data: { id, path, method, body } }); });
}
async function timed(path, body) {
  const t0 = performance.now();
  const r = await api(path, 'POST', body);
  timings.push(performance.now() - t0);
  return r;
}

const NSEEDS = Number(process.argv[2] || 40);
const SWEEP_TRIALS = 1000, STEP_TRIALS = 400, STEP_LOSSES = 2;
let fails = 0, swept = 0, bailed = 0, wonBySweep = 0, offers = 0;
const fail = (m) => { fails++; if (fails <= 10) console.error('  ' + m); };

for (let seed = 1; seed <= NSEEDS; seed++) {
  let s = await api('/api/game', 'POST', { seed });
  if (s.error) { fail(`seed ${seed}: new game failed: ${s.error}`); continue; }
  const gid = s.id;
  let guard = 2000, sweepRun = false;
  while (!s.over && guard-- > 0) {
    const chk = await timed(`/api/game/${gid}/sweep-check`, { trials: SWEEP_TRIALS });
    if (chk.error) { fail(`seed ${seed}: sweep-check failed: ${chk.error}`); break; }
    if (chk.ok && s.turn === 1) fail(`seed ${seed}: certified the opening as a won mop-up`);
    if (chk.ok) {
      offers++;
      // the pages' sweep loop: re-check, then play the move the certificate covers
      sweepRun = true; swept++;
      let g2 = 400, out = 'exhausted';
      while (!s.over && g2-- > 0) {
        const st = await api(`/api/game/${gid}/sweep-check`, 'POST',
          { trials: STEP_TRIALS, maxLosses: STEP_LOSSES });
        if (!st.ok) { out = 'bailed'; break; }
        if (st.move && !(s.legalMoves || []).some(m => m.from === st.move.from && m.to === st.move.to))
          fail(`seed ${seed}: sweep move ${st.move.from}->${st.move.to} is not legal here`);
        s = st.move ? await api(`/api/game/${gid}/attack`, 'POST', st.move)
                    : await api(`/api/game/${gid}/end-turn`, 'POST');
        if (s.error) { fail(`seed ${seed}: sweep action failed: ${s.error}`); out = 'error'; break; }
      }
      if (out === 'bailed') bailed++;
      else if (s.over) { if (s.youWon) wonBySweep++; }
      else fail(`seed ${seed}: sweep neither finished nor bailed (${out})`);
      break;
    }
    // not certified: play on with the engine's own move (fast, low sims — this
    // harness is testing the routes, not measuring strength)
    const r = await api(`/api/game/${gid}/search`, 'POST', { sims: 600, maxSims: 600 });
    if (r.error) { fail(`seed ${seed}: search failed: ${r.error}`); break; }
    const best = r.best;
    s = best && best.action >= 0
      ? await api(`/api/game/${gid}/attack`, 'POST', { from: best.from, to: best.to })
      : await api(`/api/game/${gid}/end-turn`, 'POST');
    if (s.error) { fail(`seed ${seed}: action failed: ${s.error}`); break; }
  }
  if (s.over) {
    const post = await api(`/api/game/${gid}/sweep-check`, 'POST', { trials: 50 });
    if (post.ok || !post.over) fail(`seed ${seed}: sweep-check on a finished game: ${JSON.stringify(post)}`);
  } else if (!sweepRun) {
    fail(`seed ${seed}: game neither ended nor was swept`);
  }
}

timings.sort((a, b) => a - b);
const med = timings[timings.length >> 1] || 0, worst = timings[timings.length - 1] || 0;
console.error(`${NSEEDS} seeds: ${offers} sweep offers, ${swept} swept `
  + `(${wonBySweep} finished as wins, ${bailed} handed back mid-sweep)`);
// The offer is re-certified after every move, so this is per-move UI cost. A PASSING
// certificate is the worst case: it runs all SWEEP_TRIALS playouts (a failing one
// stops at the first loss, which is why the median is ~0).
console.error(`${SWEEP_TRIALS}-trial certificate in WASM: median ${med.toFixed(1)} ms, `
  + `worst ${worst.toFixed(1)} ms over ${timings.length} checks`);
console.error('WORKER-GATE:', fails === 0 ? 'PASS' : `${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
