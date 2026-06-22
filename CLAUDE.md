# Network Wars — project instructions

## Gameplay policy
- **Never surrender.** When driving the real game (iOS mirroring or otherwise),
  play every game out to its natural terminal (a faction reaching 24 nodes). A
  losing or partial game is more valuable played to the end than forfeited —
  keep partial-game data, do not Surrender to reset. Restart only via the
  post-game (win/loss) modal's New Game / Play Again button.

## Engine (pure MCTS — RL/neural-net path was removed)
- `rl/` is the search + analysis subproject. **Pure C-UCT MCTS (no neural net) is
  our best algorithm** — the AlphaZero/PufferLib training path was dropped (it
  plateaued below the search; findings in memory `alphago-levers-ruled-out`). There
  is no Gymnasium env or torch/pufferlib dependency anymore.
- Three engine ports model the **real iOS app (the source of truth)** and are kept
  bit-identical: `rl/network_wars.py` (the readable Python spec), `rl/fast_engine.c`
  (the C hot path + UCT search, for speed), and `game.js` (the browser-playable
  version). Each has a distinct consumer; automated parity gates keep them in sync:
  `validate_fast.py` (C↔Python, bit-exact: 1000 primitives + 600 playouts) and
  `verify_port.py` (Python↔JS, 400 games).
- Two things were recalibrated from live play: the deal (every faction totals 20, 4
  fixed templates) and battle. BATTLE is the **power-ratio** model (fit from ~3300
  live battles, see rl/BATTLE_FUNCTION.md): per round the attacker wins w.p.
  `a^0.62/(a^0.62 + 0.93·d^0.62)`; a capture needs the attacker to keep an occupier
  (node→a-1 ≥1, never 0), a repel gutts the defender to `max(0,d0-a0+1)` (can be 0).
  q is truncated to 1e-6 for JS↔Py parity; `ATTACKER_WIN_P` is legacy/unused.
- Build + drive: `cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so`,
  then `fmcts.py` (or `par_eval.py` for parallel winrate evals). On the iOS-faithful
  deal, offline self-play winrate is ~91–96%. NOTE: measured LIVE winrate is ~77-81%
  (last-50 ≈76%, matching the phone's own stats screen) — offline OVER-predicts live,
  an open gap (likely real iOS bots stronger than best_bot_move; see
  BATTLE_FUNCTION.md §4 + memories sim-vs-real-deal-imbalance,
  sim-vs-real-battle-mismatch). Don't quote 88-92% as the live number.

## Driving the real iOS app
- `rl/iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring.
- `series.py` runs a series of live games with the C-UCT engine and logs a rich
  JSONL (full trajectory + per-move win expectation + algo config). It never
  surrenders (see policy above).
