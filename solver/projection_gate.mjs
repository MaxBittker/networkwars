import assert from 'node:assert/strict';
import { aiWinCurve, youWinCurve } from '../public/projections.js';
import { REVIEW_VERSION, invalidateStaleReview } from '../public/review.js';
import { skillHistory } from '../public/skill.js';
const moves = [{ a: [0, 1] }, { e: 1 }, { e: 1 }, { e: 1 }];
const partial = { moves: [null, { turn: 1, bestQ: .95 }, { turn: 2, bestQ: .4 }, null] };
assert.deepEqual(youWinCurve(partial, moves), [{ t: 1, q: null }, { t: 2, q: .4 }, { t: 3, q: null }]);
partial.moves[0] = { turn: 1, bestQ: .6 };
assert.equal(youWinCurve(partial, moves)[0].q, .6);
assert.deepEqual(aiWinCurve([{ a: [0, 1] }, { e: 1, q: .95 }, { e: 1, q: .4 }]),
  [{ t: 1, q: null }, { t: 2, q: .4 }]);
// Stored old reviews with replay actions get requeued; compact old scores survive
// as historical data but must not enter comparisons against the corrected math.
const old = { rounds: [
  { you: { result: 'win', moves, review: { version: REVIEW_VERSION - 1 } } },
  { trim: true, you: { result: 'win', moves: [], review: { moves: [{ gap: 1, dead: false }] } } },
  { you: { moves, review: { version: REVIEW_VERSION, moves: [] } } }
] };
const restored = structuredClone(old);
restored.rounds.forEach(invalidateStaleReview);
assert.equal(restored.rounds[0].you.review, null);
assert.equal(restored.rounds[1].you.review.stale, true);
assert.equal(restored.rounds[1].you.review.moves[0].gap, 1);
assert.equal(restored.rounds[2].you.review.version, REVIEW_VERSION);
assert.equal(skillHistory(restored.rounds).some(g => g.value != null), false);
console.log('PASS: turn-start projections, partial-review holes, review-version migration and preserved legacy data');
