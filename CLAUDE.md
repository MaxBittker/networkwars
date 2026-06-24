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
  - `solver/server.py` — stdlib HTTP server exposing `/api/game/*`; the browser
    (`public/index.html`) plays the **same C engine** over HTTP (no JS rules engine).
  There is no second port and no `game.js` anymore. The regression gate is
  `solver/validate_fast.py` (board/deal/battle invariants over 1000 seeds + frozen
  golden-seed game outcomes).
- Two things were recalibrated from live play: the deal (every faction totals 20, 4
  fixed templates) and battle. BATTLE is the **single-shot power-ratio** model
  (re-fit 2026-06-23 from 7,222 live red battles, see solver/BATTLE_FUNCTION.md §6):
  one Bernoulli decides the whole fight, `P(capture)=a^3.40/(a^3.40 + 1.26·d^3.40)`;
  on capture the occupier = `max(1, a−d)` (source→1), on repel the defender is gutted
  to `max(0, d−a+1)` (source→1). This is simplest + best-fitting (AIC 5941 vs the old
  iterated k=0.62 model's 6077, which was too soft at the contested margins).
- BOTS: each of the four bots greedily attacks **strongest-own-node first**, then that
  node's **weakest reachable target**, ties broken at random (matches observed iOS
  bot ordering); then reinforces its largest component's border. The RNG is seeded
  per game so outcomes stay reproducible (golden-seed gate holds).
- Build + drive: `cc -O3 -ffast-math -shared -fPIC solver/fast_engine.c -o
  solver/fast_engine.so`, then `solver/fmcts.py` (or `solver/par_eval.py` for
  parallel winrate evals), or `solver/server.py` to play in a browser. On the
  iOS-faithful deal, offline self-play winrate is ~91–96%. NOTE: measured LIVE
  winrate is ~77-81% (last-50 ≈76%, matching the phone's own stats screen) — offline
  OVER-predicts live, an open gap (likely real iOS bots stronger than best_bot_move;
  see BATTLE_FUNCTION.md §4 + memories sim-vs-real-deal-imbalance,
  sim-vs-real-battle-mismatch). Don't quote 88-92% as the live number.

## Driving the real iOS app
- `solver/iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring.
- `series.py` runs a series of live games with the C-UCT engine and logs a rich
  JSONL (full trajectory + per-move win expectation + algo config). It never
  surrenders (see policy above).
