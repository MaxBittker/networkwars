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

// ---- battle postconditions: capture => source==1, occupier == fitOcc(a,d) in
// [1,a]; repel => source==1, defender remnant == fitDefrem(a,d) in [0,d]. Fitted
// survivor curves, integer arithmetic, bit-identical to C (mirrors validate_fast) ----
const iround100 = (n) => n >= 0 ? Math.trunc((n + 50) / 100) : -Math.trunc(((-n) + 50) / 100);
const fitOcc = (a, d) => Math.min(a, Math.max(1, iround100(82 * a - 44 * d + 10)));
const fitDefrem = (a, d) => Math.min(d, Math.max(0, iround100(53 * d - 26 * a + 35)));
E.setTopologyCsr(2, [[1], [0]]);
let bTrials = 0, bFails = 0;
for (let a0 = 1; a0 <= 11; a0++) for (let d0 = 1; d0 <= 11; d0++) for (let k = 0; k < 6; k++) {
  const owner = Int32Array.from([0, 1]);
  const strength = Int32Array.from([a0, d0]);
  E.useSim(0x1234 + a0 * 131 + d0 * 7 + k);
  const { meta } = E.attackLogged(owner, strength, 0, 1);
  bTrials++;
  const ok = meta.captured
    ? (owner[1] === 0 && strength[0] === 1 && strength[1] === fitOcc(a0, d0))
    : (owner[1] === 1 && strength[0] === 1 && strength[1] === fitDefrem(a0, d0));
  if (!ok) { bFails++; if (bFails <= 5) console.error(`  battle a0=${a0} d0=${d0}: cap=${meta.captured} own=${[...owner]} str=${[...strength]}`); }
}
console.error(`battle invariants: ${bTrials - bFails}/${bTrials} ok`);

// ---- search sanity: returns children, q in [0,1] ----
const gs = E.newGame(42);
E.useSim(0x12345678);
const s = E.uctSearch(gs.owner, gs.strength, 1, 4000, 2.5, 1);
const qOk = s.acts.length > 0 && [...s.q].every((q) => q >= 0 && q <= 1);
console.error(`search sanity: ${qOk ? 'ok' : 'FAIL'} (${s.acts.length} children)`);

const pass = invFails === 0 && detFails === 0 && bFails === 0 && qOk;
console.error('WASM-GATE:', pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
