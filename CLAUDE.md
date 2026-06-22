# Network Wars — project instructions

## Gameplay policy
- **Never surrender.** When driving the real game (iOS mirroring or otherwise),
  play every game out to its natural terminal (a faction reaching 24 nodes). A
  losing or partial game is more valuable played to the end than forfeited —
  keep partial-game data, do not Surrender to reset. Restart only via the
  post-game (win/loss) modal's New Game / Play Again button.

## RL / engine
- `rl/` is the training + analysis subproject. `rl/network_wars.py`, `game.js`, and
  `rl/fast_engine.c` all model the **real iOS app (the source of truth)** and are kept
  bit-identical. Two things were recalibrated from live play: the deal (every faction
  totals 20, 4 fixed templates) and battle. BATTLE is now the **power-ratio** model
  (fit from ~3300 live battles, see rl/BATTLE_FUNCTION.md): per round the attacker wins
  w.p. `a^0.62/(a^0.62 + 0.93·d^0.62)`; a capture needs the attacker to keep an
  occupier (node→a-1 ≥1, never 0), a repel gutts the defender to `max(0,d0-a0+1)` (can
  be 0). All three engines carry this (q truncated to 1e-6 for JS↔Py parity);
  `ATTACKER_WIN_P` is legacy/unused. `fast_engine_pr.c` is now identical to
  `fast_engine.c`. `verify_port.py` confirms JS↔Python parity (400 games). Keep them
  in sync with each other and with what we measure from iOS.
- Pure C-UCT MCTS (no neural net) is the strongest seed-free policy: build with
  `cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so`; drive via
  `fmcts.py` (or `par_eval.py` for parallel winrate evals). On the iOS-faithful
  deal, offline self-play winrate is ~91% (96% with the corrected power-ratio
  battle), far above the old i.i.d.-deal ~75%. NOTE: measured LIVE winrate is
  ~77-81% (last-50 ≈76%, matching the phone's own stats screen) — offline
  OVER-predicts live, an open gap (likely real iOS bots stronger than best_bot_move;
  see BATTLE_FUNCTION.md §4 + memories sim-vs-real-deal-imbalance,
  sim-vs-real-battle-mismatch). Don't quote 88-92% as the live number.

## Driving the real iOS app
- `rl/iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring.
- `series.py` runs a series of live games with the C-UCT engine and logs a rich
  JSONL (full trajectory + per-move win expectation + algo config). It never
  surrenders (see policy above).
