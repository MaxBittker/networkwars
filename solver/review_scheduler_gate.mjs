// Deterministic orchestration tests; actual search/replay parity is review_gate.mjs.
import assert from 'node:assert/strict';
import { createReviewer, REVIEW_SIMS } from '../public/review.js';
import { createReplayInspector } from '../public/replay.js';
import fs from 'node:fs';
import vm from 'node:vm';
const tick = () => new Promise(resolve => setImmediate(resolve));
const round = (seed, n) => ({ seed, you: { moves: Array.from({ length: n }, () => ({ e: 1 })) } });
const searches = [];
let onSearch = () => {}, active = 0, peak = 0, truncated = false, failNext = false;
const makeEngine = () => {
  const games = new Map(); let id = 0;
  return async (path, method, body) => {
    if (path === '/api/game') {
      const game = { id: ++id, turn: 1, seed: body.seed, nodes: [] };
      games.set(String(id), game); return game;
    }
    const key = path.split('/')[3], game = games.get(key);
    if (method === 'DELETE') { games.delete(key); return { ok: true }; }
    if (path.endsWith('/end-turn')) {
      const next = { ...game, turn: game.turn + 1 }; games.set(key, next); return next;
    }
    if (path.endsWith('/search')) {
      searches.push([game.seed, game.turn]); active++; peak = Math.max(peak, active); onSearch();
      try {
        await tick();
        if (failNext) { failNext = false; throw new Error('injected failure'); }
        await tick();
        return { done: !truncated, sims: truncated ? 2000 : REVIEW_SIMS,
          all: [{ action: -1, visits: 100, q: .5 }] };
      } finally { active--; }
    }
    throw new Error(`unexpected request ${path}`);
  };
};

const reviewer = createReviewer(makeEngine, 1);
let foreground;
onSearch = () => {
  if (searches.length === 1) foreground = reviewer.grade(round(2, 1));
};
await reviewer.grade(round(1, 10));
await foreground;
assert.deepEqual(searches.slice(0, 2), [[1, 1], [2, 1]], 'foreground waits only for current position');
onSearch = () => {};

const r = round(3, 6), complete = await reviewer.grade(r);
const checkpoint = structuredClone(complete);
checkpoint.moves[1] = checkpoint.moves[4] = null;
checkpoint.partial = { done: 4, total: 6 };
searches.length = 0;
assert.deepEqual(await reviewer.grade({ ...r, you: { ...r.you, review: checkpoint } }), complete);
assert.equal(searches.length, 2);
for (const invalid of [{ ...checkpoint, version: -1 }, { ...checkpoint, source: 'wrong game' }]) {
  searches.length = 0;
  await reviewer.grade({ ...r, you: { ...r.you, review: invalid } });
  assert.equal(searches.length, 6, 'stale checkpoint was reused');
}

truncated = true;
await assert.rejects(reviewer.grade(round(4, 2)), /interrupted/);
truncated = false;
failNext = true;
const parallel = createReviewer(makeEngine, 2);
await assert.rejects(parallel.grade(round(5, 8)), /injected failure/);
assert.equal(active, 0, 'failure returned before all lanes released their workers');
await parallel.grade(round(5, 2)); // pool remains usable after a failed search

// Lane throttle: background scoring must be able to yield the machine to the two
// play workers (a full pool starved the h2h AI to ~1/6 speed, so the seed you had
// just played never got an AI result).
const throttled = createReviewer(makeEngine, 4);
peak = 0;
await throttled.grade(round(6, 8));
assert.equal(peak, 4, 'an unthrottled pool uses every worker');
throttled.setLanes(1);
peak = 0;
await throttled.grade(round(7, 8));
assert.equal(peak, 1, 'one lane while the AI plays');
throttled.setLanes(0);
peak = 0;
const parked = throttled.grade(round(8, 8));   // must not deadlock at zero lanes
throttled.setLanes(4);                          // AI went idle mid-review: fan back out
await parked;
assert.equal(peak, 4, 'lanes resume when the AI goes idle');
assert.equal(active, 0);

// A newly finished/visible game bypasses every parked background lane, even
// while the AI throttle leaves just one active search. All old work survives.
searches.length = 0;
const priorityReviewer = createReviewer(makeEngine, 4);
priorityReviewer.setLanes(1);
let urgent;
onSearch = () => {
  if (searches.length === 1)
    urgent = priorityReviewer.grade(round(21, 3), () => {}, () => 100);
};
await priorityReviewer.grade(round(20, 8));
await urgent;
assert.deepEqual(searches.slice(0, 4), [[20, 1], [21, 1], [21, 2], [21, 3]]);
assert.equal(searches.filter(([seed]) => seed === 20).length, 8);
onSearch = () => {};

let calls = 0, replayFails = true;
const inspect = createReplayInspector(async (_path, _method, body) => {
  calls++;
  return replayFails ? { error: 'retry me' } : { frames: body.moves.map((_, k) => ({ k })) };
});
await assert.rejects(inspect(1, r.you.moves, 0), /retry me/);
replayFails = false;
assert.deepEqual(await inspect(1, r.you.moves, 0), { k: 0 });
assert.equal(calls, 2, 'failed replay was cached');
await inspect(1, r.you.moves, 1);
assert.equal(calls, 2);
r.you.moves.push({ e: 1 });
await inspect(1, r.you.moves, 6);
assert.equal(calls, 3, 'appended moves must invalidate replay');
console.log('PASS: review fairness, checkpoint identity/holes, search completion, failure cleanup, replay cache invalidation/retry');

// A near-certain best move does NOT make a losing alternative a dead decision.
const gradeValues = async (bestQ, myQ) => {
  const r = round(9, 1);
  const create = () => async path => path === '/api/game'
    ? { id: 1, turn: 1, nodes: [{ owner: 'red', strength: 2, x: 0, y: 0 },
        { owner: 'green', strength: 1, x: 1, y: 0 }] }
    : { done: true, sims: REVIEW_SIMS, all: [
        { action: 1, from: 0, to: 1, visits: 2000, q: bestQ },
        { action: -1, visits: 1000, q: myQ }] };
  return createReviewer(create, 1).grade(r);
};
const thrown = await gradeValues(.995, .3);
assert.equal(thrown.nLive, 1);
assert.equal(thrown.moves[0].dead, false);
assert.equal(thrown.moves[0].gap, 69.5);
assert.deepEqual(thrown.counts, [0, 0, 0, 1]);
assert.equal((await gradeValues(.995, .99)).nLive, 0);
assert.equal((await gradeValues(.01, .005)).nLive, 0);
assert.equal((await gradeValues(.5, .3)).nLive, 1);
assert.equal((await gradeValues(.99, NaN)).n, 0);
console.log('PASS: winning-position blunders retained; same-band extremes excluded; invalid Q unscored');

// ---- the page's background-AI pump (nextAiSeed + aiPump, run as shipped) ----
// It plays the seed you are on first and survives a seed it cannot play; both
// were regressions that left every visible pair reading "AI —".
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const played = [], lanes = [];
const pumpCtx = vm.createContext({ console: { warn() {} },
  M: { rounds: [], idx: 0 }, aiBusy: false, aiErr: {},
  seedPanelOn: () => false, sdIdx: 0,
  paintBadge: () => {},
  reviewer: { workers: 6, setLanes: (n) => lanes.push(n) },
  aiPlaySeed: async (i) => {
    played.push(i);
    if (pumpCtx.M.rounds[i].bad) throw new Error('worker exploded');
    pumpCtx.M.rounds[i].ai.result = 'won';
  } });
vm.runInContext(page.slice(page.indexOf('function nextAiSeed()'),
                           page.indexOf('// Every worker reply is checked')), pumpCtx);
const dealt = (extra = {}) => ({ startNodes: [], you: { result: null }, ai: { result: null }, ...extra });
pumpCtx.M.rounds = [dealt(), dealt(), dealt({ bad: 1 }), dealt()];
pumpCtx.M.idx = 3;
await pumpCtx.aiPump();
assert.deepEqual(played, [3, 2, 1, 0], 'the seed in play is finished first, then the backlog');
assert.deepEqual(Object.keys(pumpCtx.aiErr), ['2'], 'the unplayable seed is remembered, not retried');
assert.equal(pumpCtx.aiBusy, false);
assert.deepEqual(lanes, [1, 6], 'reviews yield the cores while the AI plays, and get them back');
// A seed dealt while the pump runs is picked up without a second pump.
played.length = 0;
const growing = pumpCtx.aiPlaySeed;
pumpCtx.aiPlaySeed = async (i) => {
  await growing(i);
  if (played.length === 1) { pumpCtx.M.rounds.push(dealt()); pumpCtx.M.idx = 4; }
};
pumpCtx.M.rounds[3].ai.result = null;
await pumpCtx.aiPump();
assert.deepEqual(played, [3, 4], 'a newly dealt seed is played next');
played.length = 0;
pumpCtx.aiPlaySeed = growing;
pumpCtx.aiErr = {};
pumpCtx.M.rounds = [dealt(), dealt({ you: { result: 'lost' } }), dealt()];
pumpCtx.M.idx = 2;
await pumpCtx.aiPump();
assert.deepEqual(played, [1, 2, 0], 'finish the just-played pair before the next seed');
pumpCtx.M.rounds = [dealt(), dealt(), dealt()];
pumpCtx.seedPanelOn = () => true;
assert.equal(pumpCtx.nextAiSeed(), 0, 'an inspected pair has priority');
console.log('PASS: AI pump plays the current seed first, isolates a failed seed, paces reviews');

// Run the actual AI move loop: interrupt an older seed, then resume its saved
// actions. Replaying the prefix must not search it again or duplicate history.
let wanted = 0, sequence = 0;
const aiGames = new Map(), aiSearches = [];
const aiRound = seed => ({ seed, rules: 2, you: {}, ai: { moves: [], hist: [] } });
const loopCtx = vm.createContext({
  M: { rounds: [aiRound(30), aiRound(31)] }, LEGACY_RULES_VERSION: 1, AI_SIMS: 6000,
  nextAiSeed: () => wanted,
  aiStep: async (path, method, body) => {
    if (path === '/api/game') {
      const s = { id: ++sequence, turn: 1, seed: body.seed, nodes: [], over: false };
      aiGames.set(String(s.id), s); return s;
    }
    const id = path.split('/')[3], s = aiGames.get(id);
    if (method === 'DELETE') { aiGames.delete(id); return {}; }
    if (path.endsWith('/search')) {
      aiSearches.push([s.seed, s.turn]);
      if (aiSearches.length === 1) wanted = 1;
      return { best: { action: -1 }, winexp: .5 };
    }
    const next = { ...s, turn: s.turn + 1, over: s.turn === 3 };
    aiGames.set(id, next); return next;
  },
  sampleHist: (g, s) => g.hist.push(s.turn),
  recordEnd: (g, s) => { assert(s.over); g.result = 'won'; },
  paintBadge() {}, save() {}, renderStrip() {}, refreshSeedPanel() {}, revealPair() {},
  sleep: tick,
});
vm.runInContext(page.slice(page.indexOf('async function aiPlaySeed(i)'),
  page.indexOf('// A finished pair is the only informative unit')), loopCtx);
await loopCtx.aiPlaySeed(0);
assert.equal(loopCtx.M.rounds[0].ai.moves.length, 1);
assert.equal(aiGames.size, 0);
await loopCtx.aiPlaySeed(1);
wanted = 0;
await loopCtx.aiPlaySeed(0);
assert.deepEqual(aiSearches, [[30, 1], [31, 1], [31, 2], [31, 3], [30, 2], [30, 3]]);
for (const r of loopCtx.M.rounds) {
  assert.equal(r.ai.moves.length, 3);
  assert.deepEqual(Array.from(r.ai.hist), [1, 2, 3, 4]);
  assert.equal(r.ai.result, 'won');
}
assert.equal(aiGames.size, 0, 'finished/suspended worker games must be deleted');
console.log('PASS: review priority; AI switches after a move and resumes without repeated searches');
