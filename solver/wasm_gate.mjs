// WASM regression gate (node): asserts the in-browser engine's structural invariants
// over many seeds + battle postconditions + determinism, mirroring validate_fast.py's
// invariant section. Also prints a per-seed board fingerprint (`FP <seed> <hex>`) that
// validate_wasm.py diffs against the NATIVE engine to prove board-gen parity.
//
//   node solver/wasm_gate.mjs [nseeds]
import { loadEngine, FACTIONS } from '../public/fastnw.js';
import { createHash } from 'crypto';

const N_SEEDS = parseInt(process.argv[2] || '1000', 10);
const TARGET_NODES = 30;

function connected(adj, n) {
  const seen = new Set([0]); const stack = [0];
  while (stack.length) {
    const v = stack.pop();
    for (const w of adj[v]) if (!seen.has(w)) { seen.add(w); stack.push(w); }
  }
  return seen.size === n;
}

function fp(g) {
  const b = Buffer.concat([
    Buffer.from(g.owner.buffer, g.owner.byteOffset, g.n * 4),
    Buffer.from(g.strength.buffer, g.strength.byteOffset, g.n * 4),
  ]);
  return createHash('md5').update(b).digest('hex').slice(0, 12);
}

const E = await loadEngine();

// ---- structural invariants + per-seed fingerprint + determinism ----
let invFails = 0, detFails = 0;
for (let seed = 1; seed <= N_SEEDS; seed++) {
  const g = E.newGame(seed);
  const bad = [];
  if (g.n !== TARGET_NODES) bad.push(`N=${g.n}`);
  const per = [0, 0, 0, 0, 0], tot = [0, 0, 0, 0, 0];
  for (let i = 0; i < g.n; i++) { per[g.owner[i]]++; tot[g.owner[i]] += g.strength[i]; }
  for (let f = 0; f < 5; f++) {
    if (per[f] !== 6) bad.push(`${FACTIONS[f]} has ${per[f]} nodes`);
    if (tot[f] !== 20) bad.push(`${FACTIONS[f]} totals ${tot[f]}`);
  }
  for (let i = 0; i < g.n; i++)
    for (const j of g.adj[i]) if (!g.adj[j].includes(i)) bad.push(`asym ${i}-${j}`);
  if (!connected(g.adj, g.n)) bad.push('disconnected');
  if (bad.length) { invFails++; if (invFails <= 5) console.error(`  seed ${seed}: ${bad.slice(0, 5).join('; ')}`); }

  console.log(`FP ${seed} ${fp(g)}`);

  // determinism: same seed twice -> identical board
  const g2 = E.newGame(seed);
  let same = g.n === g2.n;
  for (let i = 0; same && i < g.n; i++) same = g.owner[i] === g2.owner[i] && g.strength[i] === g2.strength[i];
  if (!same) { detFails++; if (detFails <= 5) console.error(`  seed ${seed}: non-deterministic board`); }
}
console.error(`invariants: ${N_SEEDS - invFails}/${N_SEEDS} seeds clean`);
console.error(`determinism: ${N_SEEDS - detFails}/${N_SEEDS} seeds reproducible`);

// ---- battle postconditions: survivors are now BINOMIAL around the fitted mean
// (BATTLE_FUNCTION.md §7). Per (a,d) assert: source always gutted to 1; capture =>
// occupier in [1,a-1]; repel => remnant in [0,d]; and the empirical mean survivor
// over many draws tracks meanOcc/meanRem (mirrors validate_fast.check_battle_invariants).
const meanOcc = (a, d) => Math.min(a - 1, Math.max(1.0, 0.82 * a - 0.44 * d + 0.10));
const meanRem = (a, d) => Math.min(d, Math.max(0.0, 0.30 + 0.24 * d + 0.42 * Math.max(0, d - a)));
E.setTopologyCsr(2, [[1], [0]]);
const BT = 4000;
let bFails = 0;
const meanOk = (vals, target, label) => {            // |emp-target| within max(0.08, 4*SE)
  if (vals.length < 150) return;
  const mu = vals.reduce((s, x) => s + x, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((s, x) => s + (x - mu) ** 2, 0) / vals.length);
  if (Math.abs(mu - target) > Math.max(0.08, 4 * sd / Math.sqrt(vals.length))) {
    bFails++; console.error(`  ${label}: ${mu.toFixed(3)} vs ${target.toFixed(3)} (n=${vals.length})`);
  }
};
for (let a0 = 2; a0 <= 11; a0++) for (let d0 = 1; d0 <= 11; d0++) {
  const occ = [], rem = [];
  for (let k = 0; k < BT; k++) {
    const owner = Int32Array.from([0, 1]);
    const strength = Int32Array.from([a0, d0]);
    E.useSim(0x1234 + a0 * 131 + d0 * 7 + k);
    const { meta } = E.attackLogged(owner, strength, 0, 1);
    let bad = strength[0] !== 1;
    if (meta.captured) { bad ||= owner[1] !== 0 || !(strength[1] >= 1 && strength[1] <= a0 - 1); occ.push(strength[1]); }
    else { bad ||= owner[1] !== 1 || !(strength[1] >= 0 && strength[1] <= d0); rem.push(strength[1]); }
    if (bad) { bFails++; if (bFails <= 5) console.error(`  battle a0=${a0} d0=${d0}: cap=${meta.captured} own=${[...owner]} str=${[...strength]}`); }
  }
  meanOk(occ, meanOcc(a0, d0), `occ mean a0=${a0} d0=${d0}`);
  meanOk(rem, meanRem(a0, d0), `rem mean a0=${a0} d0=${d0}`);
}
console.error(`battle invariants: ${bFails === 0 ? 'PASS' : bFails + ' FAIL'} (range + empirical-mean over ${BT}/cell)`);

// ---- search sanity: returns children, q in [0,1] ----
const gs = E.newGame(42);
E.useSim(0x12345678);
const s = E.uctSearch(gs.owner, gs.strength, 1, 4000, 2.5, 1);
const qOk = s.acts.length > 0 && [...s.q].every((q) => q >= 0 && q <= 1);
console.error(`search sanity: ${qOk ? 'ok' : 'FAIL'} (${s.acts.length} children)`);

const pass = invFails === 0 && detFails === 0 && bFails === 0 && qOk;
console.error('WASM-GATE:', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
