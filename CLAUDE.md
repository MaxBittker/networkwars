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
  totals 20, 4 fixed templates) and battle (`ATTACKER_WIN_P=0.60`). All three engines
  carry both; `verify_port.py` confirms JS↔Python parity (400 games). Keep them in
  sync with each other and with what we measure from iOS.
- Pure C-UCT MCTS (no neural net) is the strongest seed-free policy: build with
  `cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so`; drive via
  `fmcts.py` (or `par_eval.py` for parallel winrate evals). On the iOS-faithful
  deal, offline winrate matches live play (~88-92%), far above the old i.i.d.-deal
  ~78% (see memories sim-vs-real-deal-imbalance, sim-vs-real-battle-mismatch).

## Driving the real iOS app
- `rl/iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring.
- `series.py` runs a series of live games with the C-UCT engine and logs a rich
  JSONL (full trajectory + per-move win expectation + algo config). It never
  surrenders (see policy above).
