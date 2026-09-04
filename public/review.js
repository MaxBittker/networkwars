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
        const w = { api: makeEngine(), seed: null, s: null, pos: 0 };
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
  async function replayTo(w, r, k) {
    if (w.seed !== r.seed || w.pos > k || !w.s) {
      w.s = await w.api('/api/game', 'POST', { seed: r.seed });
      w.seed = r.seed; w.pos = 0;
    }
    while (w.pos < k) {
      const mv = r.you.moves[w.pos];
      w.s = mv.e
        ? await w.api(`/api/game/${w.s.id}/end-turn`, 'POST')
        : await w.api(`/api/game/${w.s.id}/attack`, 'POST', { from: mv.a[0], to: mv.a[1] });
      w.pos++;
    }
    return w.s;
  }

  async function grade(r, onPartial) {
    const moves = r.you.moves;
    const out = { moves: new Array(moves.length).fill(null) };
    let next = 0, done = 0, failed = false;

    const gradeOne = async (w, k) => {
      const mv = moves[k];
      const isEnd = !!mv.e;
      const from = isEnd ? null : mv.a[0], to = isEnd ? null : mv.a[1];
      const s = await replayTo(w, r, k);
      // grade:true = the engine's grading mode — root min-visit floor + full budget on
      // live positions + burn-in-free Qs, so YOUR move's Q is comparable to the best
      // move's instead of a starved child's pessimistic estimate (which inflated gaps).
      const res = await w.api(`/api/game/${s.id}/search`, 'POST',
        { sims: REVIEW_SIMS, maxSims: REVIEW_MAX, grade: true });
      if (res.error) throw new Error(res.error);
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

    // One lane per pool worker: hold the worker for the whole run so its replay
    // stays warm, and keep pulling positions until none are left.
    const lane = async () => {
      if (next >= moves.length) return;
      const w = await acquireReviewer();
      try {
        while (next < moves.length && !failed) {
          const k = next++;
          const m = await gradeOne(w, k);
          if (failed) return;              // another lane threw — the review is discarded
          out.moves[k] = m;
          done++;
          // Rolling: hand the caller a scored-so-far review after every move (marked
          // .partial), aggregates included, so the list can render as scoring runs.
          out.partial = { done, total: moves.length };
          onPartial(reviewAggregates(out));
        }
      } catch (e) {
        failed = true;                     // stop the other lanes at their next step
        throw e;
      } finally {
        releaseReviewer(w);
      }
    };
    const lanes = [];
    for (let k = 0; k < Math.min(workers, moves.length); k++) lanes.push(lane());
    await Promise.all(lanes);

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
