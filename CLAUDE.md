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
  generation + the iOS deal, the four deterministic bots, the power-ratio battle,
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
  fixed templates) and battle. BATTLE is the **power-ratio** model (fit from ~3300
  live battles, see solver/BATTLE_FUNCTION.md): per round the attacker wins w.p.
  `a^0.62/(a^0.62 + 0.93·d^0.62)`; a capture needs the attacker to keep an occupier
  (node→a-1 ≥1, never 0), a repel gutts the defender to `max(0,d0-a0+1)` (can be 0).
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
