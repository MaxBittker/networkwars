# Network Wars — project instructions

## Gameplay policy
- **Never surrender.** When driving the real game (iOS mirroring or otherwise),
  play every game out to its natural terminal (a faction reaching 24 nodes). A
  losing or partial game is more valuable played to the end than forfeited —
  keep partial-game data, do not Surrender to reset. Restart only via the
  post-game (win/loss) modal's New Game / Play Again button.

## RL / engine
- `rl/` is the training + analysis subproject. `rl/network_wars.py` is a
  bit-identical Python port of `game.js`; keep `verify_port.py` passing.
- Pure C-UCT MCTS (no neural net) is the strongest seed-free policy: build with
  `cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so`; drive via
  `fmcts.py`. True seed-free winrate plateaus ~78% (see `rl/ALPHAGO.md`).

## Driving the real iOS app
- `rl/iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring.
- `series.py` runs a series of live games with the C-UCT engine and logs a rich
  JSONL (full trajectory + per-move win expectation + algo config). It never
  surrenders (see policy above).
