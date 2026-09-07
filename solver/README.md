# Network Wars — engine + solver

One implementation of the whole game, in C, with thin clients around it (Python for
headless eval, WASM for the browser). Everything plays **RED against the four fixed
deterministic bots** — the only matchup the game has. The player is a **pure C-UCT
MCTS** (no neural net, no seed/RNG exploitation): offline self-play winrate is **~94%**
on the iOS-faithful deal, and a 100-game live run **matches it** (94.0%) — the old
sim-vs-live gap closed once the deal and battle were made faithful (the battle is the
game's own decompiled fair-coin mechanic, `REAL_BATTLE_DECOMPILED.md`).

## The engine (single source of truth)

The September 2026 [rules audit](RULES_AUDIT.md) corrected starting-army grouping,
attack/terminal validation, and a reinforcement edge case. New games use rules v2;
saved v1 games retain their original boards and dice. Earlier win-rate measurements
in this document predate the placement correction.

- **`fast_engine.c` → `fast_engine.so`** — the only implementation of board
  generation + the iOS deal, the four bots (the decompiled opponent AI,
  `REAL_BOT_DECOMPILED.md`), the decompiled fair-coin battle
  (`REAL_BATTLE_DECOMPILED.md`), reinforcement, win check, and the open-loop C-UCT search
  (ranked **C1** rollout baked in). mulberry32 for the real seeded game; a private
  splitmix64 for search dice so the search never sees the real game's dice.
- **`fastnw.py`** — thin ctypes client: marshals `(owner, strength)` int32 arrays
  in/out, exposes `new_game`, the rule primitives, and `uct_search`. No rules here.
- **`network_wars.py`** — a readable `State`/`Node` shim that delegates every rule
  to the C engine, so the `iphone_data/` analysis tools keep a convenient object API.
- **`validate_fast.py`** — the native regression gate: board/deal/battle invariants
  over 1000 seeds + frozen golden-seed game outcomes. **`validate_wasm.py`** is the
  sibling WASM gate (board-gen bit-parity vs native + battle/survivor mean+variance
  checks + determinism, via `wasm_gate.mjs` in node). Run both after touching rules.

## Run it

```sh
cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so
uv run python validate_fast.py                       # native regression gate
uv run python fmcts.py --games 120 --sims 3200 --c-puct 2.5   # one process
uv run python par_eval.py --games 1000 --sims 8000 --workers 9 # parallel winrate

./build_wasm.sh && uv run python validate_wasm.py    # rebuild + gate the browser engine
```

To play in a browser, serve `../public/` statically — the engine runs in-browser as
WASM, no Python needed (`cd ../public && python3 -m http.server`). `server.py` is only
for the live iOS `/grab` workflow.

- **`fmcts.py`** — plans with the C UCT search but applies each move to the *real*
  seeded game (via the `network_wars` shim), so outcomes are genuine — the search
  never sees the game seed. Best config (baked into the engine): ranked C1 rollout,
  `c_puct=2.5`, `sims=1600–3200`.
- **`par_eval.py`** — splits seeds across processes for fast winrate evals.
- **`server.py`** — OPTIONAL stdlib HTTP server. The browser game is serverless WASM
  (see `../public/`); this only serves `public/` and the iOS `/grab`/`/load`
  endpoints that pull a live iOS-mirrored board into a new game.

The single win% readout (live dashboard + JSONL) is **`winexp`** — the search's own
backed-up Q of the chosen move. It falls out of the MCTS (no separate calibration
model) and tracks real outcomes at AUC ~0.955.

## Driving the real iOS app

`iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring and runs
live game series with the C-UCT engine. See `iphone_data/README.md`.

Deps are managed with `uv` (`pyproject.toml` / `uv.lock`); the only runtime
dependency is `numpy<2`. `fast_engine.so` is gitignored — rebuild with the `cc` line.

## Search performance checks

`search_bench.py before.so after.so` and
`node search_bench.mjs before.mjs ../public/fast_engine.js` compare two builds
using 48 seeded opening/midgame positions, ordinary and grading searches,
4k fixed / 4k–8k adaptive budgets, and three alternating-order repetitions.
Every root action, visit count, Q value, simulation total, and game RNG position
must match. Preserve a baseline build before changing the engine; WASM baselines
outside `public/` should use the `.mjs` extension.

The September 2026 cleanup stores each uniform prior once per tree node, caches
conditional capture strength and source logarithms, shares winner/count work,
and replaces the rollout scorer's global visit stamps with a local bitset.
In this paired benchmark, native time was 29.304s → 29.022s and WASM time
32.920s → 32.620s (about 1%, small enough to treat cautiously). The clearer gain
is memory: at the browser's 150k search ceiling, allocated WASM memory fell from
99.38 MiB to 79.44 MiB, with exact search-result parity in all 288 comparisons
on each platform. These timings are local measurements, not a device-wide guarantee.

## Board replay checks

`node board_gate.mjs` checks the renderer against real engine battle logs:
casualty order, captures, repels, reinforcement, callback boundaries, speed
changes, interruption, and cleanup. It uses a virtual frame clock; inspect the
actual page for visual changes as well. `../TODO.md` records the video reference
and the gamefeel restoration checklist.

## Post-game review performance

See [`REVIEW_PERFORMANCE.md`](REVIEW_PERFORMANCE.md) for the 481-decision budget
study, resumable scoring and pool scheduling, cached historical replay, and
validation commands. `review_bench.mjs` measures the actual WASM review path;
`review_scheduler_gate.mjs` checks checkpoint identity, fairness, and failure
handling. The default 16k–24k grading budget is retained: a blanket reduction
made some blunders disappear. `review_gate.mjs` now also checks resume and exact
historical replay, and accepts an optional pre-change reviewer after the worker
count for comparison.

## Search math audit

Run `bash solver/check.sh` from the repository root to rebuild both engines and
run all gameplay, math, saved-game compatibility, worker, and review gates.

See [MATH_AUDIT.md](MATH_AUDIT.md) for sampled-legality and chance-terminal fixes,
consistent rollout horizons, exact large-stack battle estimates, corrected grading,
and projection alignment. The displayed win values remain search estimates.
Focused gates: `cc -O2 math_gate.c -lm -o /tmp/nw-math-gate && /tmp/nw-math-gate`,
`node projection_gate.mjs`, and `node review_scheduler_gate.mjs`.
