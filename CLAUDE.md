# Network Wars — project instructions

## Gameplay policy
- **Never surrender.** When driving the real game (iOS mirroring or otherwise),
  play every game out to its natural terminal (a faction reaching 24 nodes). A
  losing or partial game is more valuable played to the end than forfeited —
  keep partial-game data, do not Surrender to reset. Restart only via the
  post-game (win/loss) modal's New Game / Play Again button.

## Engine (one C source of truth; pure MCTS — RL/neural-net path was removed)
- `solver/` is the engine + search + analysis subproject. **Pure C-UCT MCTS (no
  neural net) is our best algorithm** — the AlphaZero/PufferLib training path was
  dropped (it plateaued below the search; findings in memory
  `alphago-levers-ruled-out`). No Gymnasium env or torch/pufferlib dependency.
- **`solver/fast_engine.c` is the single implementation of everything**: board
  generation + the iOS deal, the four bots, the power-ratio battle,
  reinforcement, win check, and the open-loop C-UCT search (ranked **C1** rollout
  baked in, `c_puct=2.5`). Everything else is a thin client over it:
  - `solver/fastnw.py` — ctypes client (marshals int32 arrays; implements no rules).
  - `solver/network_wars.py` — a readable State/Node shim that delegates every rule
    to the C engine, so the `iphone_data/` analysis tooling keeps its object API.
  - `public/` — the **self-contained WASM frontend**: `fast_engine.c` is compiled to
    WASM (`public/fast_engine.js`, single-file ESM, wasm embedded) and runs IN THE
    BROWSER inside a Web Worker. `public/fastnw.js` is the JS marshalling layer (port
    of `fastnw.py`); `public/engine.worker.js` is the game/orchestration layer (port
    of `server.py`'s handlers) — it holds game state and speaks the same `/api/game/*`
    contract via postMessage, so `index.html` needs no server to play. Search runs
    in the worker so the UI never blocks (adaptive budget: floor ~2000 sims, ceiling
    ~150k, visit-margin early stop — see memory `adaptive-sims`).
  - `solver/server.py` — now OPTIONAL: it serves `public/` static assets and the
    legacy `/api/game/*` (no longer used by the browser), and is only needed for the
    iOS `/grab` and `/load` workflow (live iPhone Mirroring). Pure offline play needs
    no Python — serve `public/` with any static server (`cd public && python3 -m
    http.server`) or open via the server.
  There is no JS rules engine — board-gen, bots, battle, reinforce, and search are all
  the one C source. Regression gates: `solver/validate_fast.py` (native, board/deal/
  battle invariants over 1000 seeds + frozen golden-seed outcomes) and
  `solver/validate_wasm.py` (WASM board-gen BIT-PARITY vs native over 1000 seeds +
  structural/battle invariants + determinism, via `solver/wasm_gate.mjs` in node).
- Two things came from the real game: the deal (every faction totals 20, 4 fixed
  templates) and battle. BATTLE is now the **real decompiled mechanic** —
  **iterated fair-coin attrition, zero fitted parameters** (2026-07-02; recovered
  from the shipped iOS IPA, see solver/REAL_BATTLE_DECOMPILED.md and
  ipa_decompile/). The atomic op is a **fair coin** (`killflip(team) =
  teamRandom.Next(2)`, p=0.5). `resolve_battle`: two guarded attacker **pre-fires**
  (coin → defender loses 1), then a symmetric loop (each round the attacker's coin
  can drop a defender and the defender's coin can drop an attacker) until `d==0` or
  `a==1`; **capture** iff `a>1 && d==0` → occupier `a-1`, source keeps exactly 1;
  else **repel** → source ground to 1, defender keeps remnant `d`. Survivors are NOT
  a separate draw — the attrition loop IS the survivor distribution. Coins are
  integer `RNG()<0.5` for WASM bit-parity; the search's CAPP/CAPES tables are the
  exact DP of this loop. (The old fitted single-shot `a^3.40/(a^3.40+1.26 d^3.40)` +
  beta-binomial survivor model was a good surrogate — it nailed parity ≈0.44 — but
  is now removed in favor of ground truth.)
- BOTS: each of the four bots greedily attacks **strongest-own-node first**, then that
  node's **weakest reachable target**, ties broken at random (matches observed iOS
  bot ordering); then reinforces its largest component's border. The RNG is seeded
  per game so outcomes stay reproducible (golden-seed gate holds).
- Build + drive: native `cc -O3 -ffast-math -shared -fPIC solver/fast_engine.c -o
  solver/fast_engine.so`, then `solver/fmcts.py` (or `solver/par_eval.py` for
  parallel winrate evals), or `solver/server.py` to play in a browser. WASM build (for
  the in-browser engine; NOTE: **no `-ffast-math`** — it breaks cross-arch board-gen
  bit-parity, and the search doesn't need it): run `solver/build_wasm.sh` (emcc
  single-file ESM → `public/fast_engine.js`), then validate with `python3
  solver/validate_wasm.py`. On the iOS-faithful deal, offline self-play winrate is
  **~94–95%** (8000 sims). The old offline-over-predicts-live gap is **CLOSED**: after
  the battle/survivor recalibration above, a 100-game live run scored **94.0%** (CI
  87.5–97.2%), matching offline at the same C-UCT config (memory
  `sim-real-gap-closed-2026-06-29`, supersedes the old ~77–81% plateau). Most of the
  few losses are early dice-snowballs, not search errors.

## Driving the real iOS app
- `solver/iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring.
- `series.py` runs a series of live games with the C-UCT engine and logs a rich
  JSONL (full trajectory + per-move win expectation + algo config). It never
  surrenders (see policy above).
