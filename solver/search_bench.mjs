// Compare two WASM builds with paired timings and exact root-stat/RNG parity.
// node solver/search_bench.mjs /path/before.mjs public/fast_engine.js [seeds=12] [sims=4000]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [before, after, seedArg = '12', simsArg = '4000'] = process.argv.slice(2);
if (!before || !after) throw new Error('Provide before and after WASM module paths');
const wrapper = await readFile(new URL('../public/fastnw.js', import.meta.url), 'utf8');
const engines = [];
for (const path of [before, after]) {
  const source = wrapper.replace("'./fast_engine.js'", JSON.stringify(pathToFileURL(resolve(path)).href));
  const { loadEngine } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  engines.push(await loadEngine());
}
const elapsed = [0, 0], ratios = [], sims = Number(simsArg);
let positions = 0, pairs = 0;
for (let seed = 1; seed <= Number(seedArg); seed++) {
  const base = engines[0], g = base.newGame(seed);
  for (let turn = 1; turn <= 4; turn++) {
    if (base.checkWinner(g.owner) >= 0 || !g.owner.includes(0)) break;
    positions++;
    for (const grade of [0, 1]) for (let repeat = 0; repeat < 3; repeat++) {
      const results = [], times = [];
      for (const k of (repeat % 2 ? [1, 0] : [0, 1])) {
        const e = engines[k];
        e.setTopologyCsr(g.n, g.adj); e.useMb32(g.mb);
        e.useSim(0x12345678); e.setGrade(grade);
        const start = performance.now();
        results[k] = e.uctSearch(g.owner, g.strength, turn, sims, 2.5, 1,
          sims * (repeat === 1 ? 2 : 1));
        times[k] = performance.now() - start; elapsed[k] += times[k];
        assert.equal(e.getMb32(), g.mb);
      }
      assert.deepEqual(results[1], results[0], `seed ${seed}, turn ${turn}, grade ${grade}`);
      assert.equal(engines[0].uctSimsDone(), engines[1].uctSimsDone());
      ratios.push(times[0] / times[1]); pairs++;
    }
    base.useMb32(g.mb);
    base._put(base._owner, g.owner); base._put(base._strength, g.strength);
    base.M._end_turn(base._owner, base._strength);
    base._getBack(base._owner, g.owner); base._getBack(base._strength, g.strength);
    g.mb = base.getMb32();
  }
}
ratios.sort((a,b) => a-b);
console.log(`PASS: ${positions} positions, ${pairs} paired searches; exact root stats and RNG`);
console.log(`Before ${(elapsed[0]/1000).toFixed(3)}s; after ${(elapsed[1]/1000).toFixed(3)}s; aggregate speedup ${(elapsed[0]/elapsed[1]).toFixed(3)}x; median paired speedup ${ratios[ratios.length>>1].toFixed(3)}x`);
// Reserve the actual browser ceiling to measure allocated linear memory as well.
for (const e of engines) {
  const g = e.newGame(1); e.uctBegin(g.owner, g.strength, 1, 2000, 2.5, 1, 150000);
}
console.log('WASM heap at 150k ceiling (MiB), before/after:', engines.map(e => (e.M.HEAP32.buffer.byteLength / 2**20).toFixed(2)).join(' / '));
