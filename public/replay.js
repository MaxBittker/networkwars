// Keep the two inspected trajectories (you + AI) in memory. Concurrent hovers
// share the same request; revisiting any move needs no replay or worker message.
import { RULES_VERSION } from './game-version.js';

export function createReplayInspector(api) {
  const cache = [];
  return async (seed, moves, k, rules = RULES_VERSION) => {
    if (!Number.isInteger(k) || k < 0 || k >= moves.length) throw new Error('invalid move index');
    let entry = cache.find(e => e.seed === seed && e.rules === rules && e.moves === moves && e.length === moves.length);
    if (!entry) {
      entry = { seed, rules, moves, length: moves.length };
      entry.result = api('/api/replay', 'POST', { seed, rules, moves }).then(r => {
        if (r.error) throw new Error(r.error);
        return r.frames;
      }).catch(err => {
        const i = cache.indexOf(entry);
        if (i >= 0) cache.splice(i, 1);
        throw err;
      });
      cache.push(entry);
      if (cache.length > 2) cache.shift();
    }
    return (await entry.result)[k];
  };
}
