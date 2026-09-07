// Regression gate for progress comparisons, missing history and quota/backlog bugs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { skillHistory, skillComparison, skillTrend } from '../public/skill.js';
const round = (gap, n = 1) => ({ seed: 11, you: { result: 'won', hist: [],
  moves: Array.from({ length: n }, () => ({ e: 1, l: 'label' })),
  review: { moves: Array.from({ length: n }, () => ({ gap, dead: false })) } },
  ai: { result: 'won', moves: [{ e: 1 }], hist: [] } });
const games = (a, b) => Array.from({ length: 40 }, (_, i) => round(i < 20 ? a : b));
const compare = rs => skillComparison(skillHistory(rs));
assert.equal(compare(games(12, 5)).state, 'better');
assert.equal(compare(games(5, 12)).state, 'worse');
assert.equal(compare(games(5, 5)).state, 'unclear');
assert.equal(compare(games(5, 5.2)).state, 'unclear');
assert.equal(compare(games(5, 5).slice(0, 19)).state, 'early');
assert.equal(compare(games(5, 5).slice(0, 20)).size, 10);
const noisy = Array.from({ length: 40 }, (_, i) => round((i % 2) * 30 + (i < 20 ? 2 : 0)));
assert.equal(compare(noisy).state, 'unclear', 'noisy small difference should not claim improvement');
const equalWeight = games(10, 5);
equalWeight[0] = round(30, 200);
assert.equal(compare(equalWeight).earlier, 11, 'long games must not dominate the comparison');
const dead = games(12, 5);
dead.forEach(r => r.you.review.moves.push({ gap: 0, dead: true }, null, { gap: null }));
assert.equal(compare(dead).earlier, 12);
const noLive = games(12, 5);
noLive.slice(20, 31).forEach(r => r.you.review.moves[0].dead = true);
assert.equal(compare(noLive).state, 'few-live');
const missing = games(12, 5);
missing[39].you.review = null;
assert.equal(compare(missing).state, 'incomplete', 'latest unscored game cannot be replaced by an older review');
missing[39].you.moves = []; missing[39].trim = 1;
let history = skillHistory(missing);
assert.equal(history[39].status, 'unavailable', 'trimmed history must never remain queued');
assert.equal(compare(missing).unavailable, 1);
const partial = games(12, 5);
partial[39].you.review.partial = { done: 1, total: 2 };
assert.equal(skillHistory(partial, new Set([39]))[39].status, 'active');
assert.equal(skillHistory(partial)[39].status, 'queued', 'saved checkpoint is not an active worker');
assert.equal(skillHistory(partial, new Set(), { 39: 'failure' })[39].status, 'failed');
assert.equal(compare(partial).state, 'incomplete');
assert.equal(skillTrend(history).at(-1).trend, null);
assert.deepEqual(skillTrend(history, 10), skillTrend(history).slice(-10), 'zoom preserves trailing context and gaps');
// Earlier unavailable history does not prevent a fully covered recent comparison.
assert.equal(compare([...missing, ...games(12, 5)]).state, 'better');
assert.deepEqual(skillHistory([{ you: { result: null } }]), []);

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ctx = vm.createContext({ console, M: { rounds: [], idx: -1 }, reviewing: new Set(),
  trimNoted: true, reviewErr: {}, scoreBusy: false });
vm.runInContext(html.slice(html.indexOf('function trimOldest()'), html.indexOf('function load()')), ctx);
const unscored = round(10); unscored.you.review = null;
const finished = round(7);
ctx.M.rounds = [unscored, finished];
assert.equal(ctx.trimOldest(), true);
assert.equal(finished.trim, 1, 'prefer trimming a scored game');
assert.equal(finished.you.review.moves[0].gap, 7);
assert.equal(unscored.you.moves.length, 1);
assert.equal(ctx.trimOldest(), true);
assert.equal(unscored.lean, 1);
assert.equal(unscored.you.moves[0].e, 1, 'retain actions needed for scoring');
assert.equal(unscored.you.moves[0].l, undefined);
assert.equal(ctx.trimOldest(), false, 'do not discard the remaining unscored actions');
unscored.you.review = round(10).you.review;
assert.equal(ctx.trimOldest(), true, 'compact queued games can be fully trimmed after grading');
assert.equal(unscored.trim, 1);
const calls = [];
ctx.M.rounds = [round(10), round(10), round(10)];
ctx.M.rounds.forEach(r => r.you.review = null);
ctx.runReview = async i => {
  calls.push(i);
  if (i === 2) ctx.reviewErr[i] = 'failed';
  else ctx.M.rounds[i].you.review = { moves: [] };
};
vm.runInContext(html.slice(html.indexOf('async function scorePump()'), html.indexOf('// ============================ menu')), ctx);
await ctx.scorePump();
assert.deepEqual(calls, [2, 1, 0], 'one failed game must not strand the backlog');
console.log('PASS: trend direction/noise, equal game weighting, coverage, partials, zoom, quota preservation, failed-game queue continuation');
