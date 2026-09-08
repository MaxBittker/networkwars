// Complete AI games + full-budget grading, before/after WASM with exact parity.
// node solver/latency_bench.mjs /tmp/before.mjs public/fast_engine.js [11,16]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [before, after, seedArg = '11,16'] = process.argv.slice(2);
if (!before || !after) throw new Error('Provide before and after WASM module paths');
const wrapper = await readFile(new URL('../public/fastnw.js', import.meta.url), 'utf8');
const factories = [];
for (const path of [before, after]) {
  const source = wrapper.replace("'./fast_engine.js'", JSON.stringify(pathToFileURL(resolve(path)).href))
    .replaceAll("'./game-version.js'", JSON.stringify(new URL('../public/game-version.js', import.meta.url).href));
  factories.push((await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).loadEngine);
}
for (const seed of seedArg.split(',').map(Number)) {
  const runs = [];
  for (const [index, make] of factories.entries()) {
    const e = await make(), g = e.newGame(seed), searches = [], moves = [];
    e.setValueStop(.03, .97, .15, 512);
    let turn = 1;
    const advance = mv => {
      e.useMb32(g.mb); e.replayMove(g.owner, g.strength, mv); g.mb = e.getMb32();
      if (mv.e) turn++;
    };
    const started = performance.now();
    while (e.checkWinner(g.owner) < 0 && g.owner.includes(0)) {
      assert(moves.length < 4000);
      e.useSim(0x12345678);
      const r = e.uctSearch(g.owner, g.strength, turn, 6000, 2.5, 1, 150000);
      searches.push({ ...r, sims: e.uctSimsDone() });
      let best = 0;
      for (let k = 1; k < r.acts.length; k++) if (r.visits[k] > r.visits[best]) best = k;
      const action = r.acts[best], mv = action === -1 ? { e: 1 } : { a: [action >> 8, action & 255] };
      moves.push(mv); advance(mv);
    }
    const aiMs = performance.now() - started;
    const terminal = { owner: g.owner.slice(), strength: g.strength.slice(), mb: g.mb, turn };
    Object.assign(g, e.newGame(seed)); turn = 1;
    e.setGrade(1);
    const grades = [], reviewStarted = performance.now();
    for (const mv of moves) {
      e.useSim(0x12345678);
      grades.push({ ...e.uctSearch(g.owner, g.strength, turn, 16000, 2.5, 1, 24000), sims: e.uctSimsDone() });
      advance(mv);
    }
    const reviewMs = performance.now() - reviewStarted;
    runs.push({ searches, moves, terminal, grades });
    console.log(`seed ${seed} ${index ? 'after' : 'before'}: ${moves.length} moves; AI ${(aiMs/1000).toFixed(2)}s; serial review ${(reviewMs/1000).toFixed(2)}s`);
  }
  assert.deepEqual(runs[1], runs[0]);
  console.log(`PASS seed ${seed}: exact actions, every root Q/visit count, grading results and final dice/board`);
}
