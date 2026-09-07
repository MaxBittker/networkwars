// Decision scoring for the head-to-head page: replay YOUR recorded game and grade
// every decision against a grading-mode search, in parallel across a pool of
// dedicated engine workers. Pure orchestration over engine.worker.js — no game
// rules live here (all of those are fast_engine.c). The page owns the model,
// persistence and rendering; this module only turns a round into a review.

// Review budget: one grading-mode search per decision you made. Grading mode
// disables the dominance early-stops, so live positions run to the 24k ceiling
// (per `hard-set-2026-07-02` quality saturates ~32k) and the 16k floor only
// bounds how early the decisive "position is decided" stop may fire — every
// scored decision gets at least 16k sims.
export const REVIEW_SIMS = 16000, REVIEW_MAX = 24000;
// Bump when grading semantics/search results change. Checkpoints additionally
// identify the exact seed + action sequence, so they cannot grade another game.
export const REVIEW_VERSION = 1;
const reviewSource = r => JSON.stringify([r.seed,
  r.you.moves.map(m => m.e ? -1 : m.a)]);

export const TIERS = [
  { min: 20, k: 3, label: 'Blunder' },
  { min: 10, k: 2, label: 'Mistake' },
  { min: 5,  k: 1, label: 'Inaccuracy' },
];
// Outside this win% band the game is already decided and no choice can change it.
export const DEAD_LO = 0.02, DEAD_HI = 0.98;
export const tierOf = (gap) => (TIERS.find(t => gap >= t.min) || { k: 0, label: 'OK' });

// Pool size: the machine minus the two workers already playing (yours + the
// AI's), capped so a big desktop doesn't fan out past diminishing returns.
export const REVIEW_WORKERS = Math.max(1, Math.min(6,
  ((globalThis.navigator && navigator.hardwareConcurrency) || 4) - 2));

// `makeEngine()` returns a request fn `(path, method, body) => Promise` over a
// fresh engine.worker.js (the page's own helper, shared with its two play workers).
export function createReviewer(makeEngine, workers = REVIEW_WORKERS) {
  // Every grading search runs on a pool of dedicated workers, never on yours or
  // the AI's: engine.worker.js aborts an in-flight search the moment another
  // request queues behind it, so a tap or an inspector replay on a shared worker
  // would silently truncate a grading search below its 16k floor. Workers are
  // created lazily on the first review and live for the page.
  const reviewPool = { all: [], free: [], waiting: [] };
  function acquireReviewer() {
    if (!reviewPool.all.length)
      for (let k = 0; k < workers; k++) {
        const w = { api: makeEngine(), replays: new Map() };
        reviewPool.all.push(w); reviewPool.free.push(w);
      }
    if (reviewPool.free.length) return Promise.resolve(reviewPool.free.pop());
    return new Promise(res => reviewPool.waiting.push(res));
  }
  function releaseReviewer(w) {
    const next = reviewPool.waiting.shift();
    if (next) next(w); else reviewPool.free.push(w);
  }
  // Advance a reviewer's private replay of round r to the position before move k
  // (bit-exact: the seed pins deal + dice, the moves are the recorded ones). Each
  // reviewer keeps its replay between positions and only steps forward, so scoring
  // a game costs each worker ONE pass over the moves, not a restart per position.
  async function replayTo(w, r, k, source) {
    let replay = w.replays.get(source);
    if (replay && replay.pos > k) {
      await w.api(`/api/game/${replay.s.id}`, 'DELETE');
      w.replays.delete(source);
      replay = null;
    }
    if (!replay) {
      // Keep background + foreground replays warm when sharing workers, with
      // bounded memory even if many historical panels are opened in succession.
      if (w.replays.size >= 2) {
        const [key, old] = w.replays.entries().next().value;
        await w.api(`/api/game/${old.s.id}`, 'DELETE');
        w.replays.delete(key);
      }
      const s = await w.api('/api/game', 'POST', { seed: r.seed });
      if (s.error) throw new Error(s.error);
      replay = { s, pos: 0 };
    }
    w.replays.delete(source);
    w.replays.set(source, replay);
    while (replay.pos < k) {
      const mv = r.you.moves[replay.pos];
      const s = mv.e
        ? await w.api(`/api/game/${replay.s.id}/end-turn`, 'POST')
        : await w.api(`/api/game/${replay.s.id}/attack`, 'POST', { from: mv.a[0], to: mv.a[1] });
      if (s.error) { w.replays.delete(source); throw new Error(s.error); }
      replay.s = s;
      replay.pos++;
    }
    return replay.s;
  }

  async function grade(r, onPartial = () => {}) {
    const moves = r.you.moves;
    const source = reviewSource(r), saved = r.you.review;
    const reusable = saved?.version === REVIEW_VERSION && saved.source === source
      && saved.moves.length === moves.length;
    const out = { version: REVIEW_VERSION, source,
      moves: reusable ? saved.moves.slice() : new Array(moves.length).fill(null) };
    const pending = out.moves.flatMap((m, k) => m ? [] : [k]);
    let next = 0, done = moves.length - pending.length, failed = false;

    const gradeOne = async (w, k) => {
      const mv = moves[k];
      const isEnd = !!mv.e;
      const from = isEnd ? null : mv.a[0], to = isEnd ? null : mv.a[1];
      const s = await replayTo(w, r, k, source);
      // grade:true = the engine's grading mode — root min-visit floor + full budget on
      // live positions + burn-in-free Qs, so YOUR move's Q is comparable to the best
      // move's instead of a starved child's pessimistic estimate (which inflated gaps).
      const res = await w.api(`/api/game/${s.id}/search`, 'POST',
        { sims: REVIEW_SIMS, maxSims: REVIEW_MAX, grade: true });
      if (res.error) throw new Error(res.error);
      if (!res.done || res.sims < REVIEW_SIMS) throw new Error('grading search interrupted');
      const all = res.all || res.top || [];
      const best = all[0] || null;
      const mine = all.find(m => isEnd ? m.action === -1 : (m.from === from && m.to === to));
      // Unvisited tail moves have no reliable Q — record the move but leave it unscored
      // rather than inventing a number (same guard the live blunder alert uses).
      const scored = !!(best && mine && mine.visits > 0);
      const gap = scored ? Math.max(0, (best.q - mine.q) * 100) : null;
      // Labels carry only what the move lists render (pip owner/strength + the arrow's
      // x/y); Qs are kept to 4 dp. The review is persisted per seed, so its footprint
      // is what bounds how many seeds fit in localStorage.
      const pip = (n) => ({ owner: n.owner, strength: n.strength, x: n.x, y: n.y });
      const r4 = (v) => v == null ? null : Math.round(v * 1e4) / 1e4;
      const label = isEnd ? null : { f: pip(s.nodes[from]), t: pip(s.nodes[to]) };
      const bestDiffers = scored && best !== mine;
      const bestLbl = !bestDiffers ? null
        : (best.action === -1 ? 'end' : { f: pip(s.nodes[best.from]), t: pip(s.nodes[best.to]) });
      // A position whose best move is already ~lost or ~won carries no decision signal:
      // EVERY legal move scores gap 0 there, so counting those would flatter you (a
      // thrown game reads as a long tail of "best" moves).
      const dead = scored && (best.q <= DEAD_LO || best.q >= DEAD_HI);
      return { n: k + 1, turn: s.turn, isEnd, label, bestLbl, dead,
        myQ: scored ? r4(mine.q) : null, bestQ: best ? r4(best.q) : null, gap: r4(gap) };
    };

    // Hand the worker back after each position. FIFO waiters from a newly opened
    // seed get a turn after the current searches, without truncating any search.
    // With only one review running, each lane still keeps its warm replay.
    const lane = async () => {
      while (next < pending.length && !failed) {
        const w = await acquireReviewer();
        try {
          if (failed || next >= pending.length) return;
          const k = pending[next++];
          const m = await gradeOne(w, k);
          if (failed) return;              // another lane threw — the review is discarded
          out.moves[k] = m;
          done++;
          // Rolling: hand the caller a scored-so-far review after every move (marked
          // .partial), aggregates included, so the list can render as scoring runs.
          out.partial = { done, total: moves.length };
          onPartial(reviewAggregates(out));
        } catch (e) {
          failed = true;                   // stop the other lanes at their next step
          throw e;
        } finally {
          releaseReviewer(w);
        }
      }
    };
    const lanes = [];
    for (let k = 0; k < Math.min(workers, pending.length); k++) lanes.push(lane());
    const results = await Promise.allSettled(lanes);
    const error = results.find(r => r.status === 'rejected');
    if (error) throw error.reason;

    delete out.partial;
    return reviewAggregates(out);
  }

  return { grade, workers };
}

// Aggregates over LIVE decisions only (a decided position ties every move, so
// counting those flatters the player). `counts` drives the tier bar; n/nLive/meanLoss
// are recorded in the saved review but no longer shown — the per-move rows say it
// better than a headline number did.
export function reviewAggregates(out) {
  const sc = out.moves.filter(m => m && m.gap != null);   // partial: null = still searching
  const live = sc.filter(m => !m.dead);
  out.n = sc.length;
  out.nLive = live.length;
  out.meanLoss = live.length ? live.reduce((a, m) => a + m.gap, 0) / live.length : 0;
  out.counts = [0, 0, 0, 0];
  for (const m of live) out.counts[tierOf(m.gap).k]++;
  return out;
}
