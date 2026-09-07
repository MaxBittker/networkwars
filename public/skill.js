// Skill is an estimate from the search, not an outcome or a win probability.
// Give each game equal weight so a long game cannot dominate the comparison.
export const COMPARE_GAMES = 20, TREND_GAMES = 10;
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const variance = xs => xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1);

export function skillHistory(rounds, reviewing = new Set(), errors = {}) {
  return rounds.flatMap((r, ri) => {
    if (!r.you.result) return [];
    const rv = r.you.review;
    const complete = !!rv && !rv.partial;
    const live = (rv?.moves || []).flatMap((m, k) =>
      m && Number.isFinite(m.gap) && !m.dead ? [{ gap: m.gap, k }] : []);
    const status = complete ? 'complete' : reviewing.has(ri) ? 'active'
      : !r.you.moves.length ? 'unavailable' : errors[ri] ? 'failed' : 'queued';
    return [{ ri, status, progress: rv?.partial, count: live.length,
      value: complete && live.length ? mean(live.map(m => m.gap)) : null,
      k: live[0]?.k ?? 0, canReplay: !r.trim && !!r.you.moves.length }];
  });
}

export function skillComparison(history) {
  // Fixed, adjacent windows of FINISHED games, never the last available reviews:
  // otherwise a backlog or auto-reviewed losses silently biases the comparison.
  const size = Math.min(COMPARE_GAMES, Math.floor(history.length / 2));
  if (size < 10) return { state: 'early', needed: 20 - history.length };
  const games = history.slice(-2 * size);
  const missing = games.filter(g => g.status !== 'complete');
  if (missing.length) return { state: 'incomplete', size, missing: missing.length,
    unavailable: missing.filter(g => g.status === 'unavailable').length };
  const before = games.slice(0, size).filter(g => g.value != null).map(g => g.value);
  const recent = games.slice(size).filter(g => g.value != null).map(g => g.value);
  if (before.length < 10 || recent.length < 10) return { state: 'few-live', size };
  const earlier = mean(before), now = mean(recent), change = earlier - now;
  // A conservative descriptive signal: small changes or changes within about
  // two standard errors of game-to-game variation are inconclusive. This isn't
  // a calibrated test of underlying skill (boards and search estimates vary).
  const margin = Math.max(0.5, 2 * Math.sqrt(variance(before) / before.length + variance(recent) / recent.length));
  return { state: change > margin ? 'better' : change < -margin ? 'worse' : 'unclear',
    earlier, now, change, size, beforeN: before.length, recentN: recent.length,
    first: games[0].ri + 1, middle: games[size - 1].ri + 1,
    recentFirst: games[size].ri + 1, last: games.at(-1).ri + 1 };
}

export function skillTrend(history, zoom = Infinity) {
  const points = history.map((game, i) => {
    const window = history.slice(Math.max(0, i - TREND_GAMES + 1), i + 1);
    const values = window.filter(g => g.value != null).map(g => g.value);
    return { ...game, trend: game.value != null && window.every(g => g.status === 'complete')
      && values.length ? mean(values) : null };
  });
  return Number.isFinite(zoom) ? points.slice(-zoom) : points;
}
