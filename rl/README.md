# Network Wars — search subproject (pure MCTS for RED)

Everything here plays **RED against the four fixed deterministic bots** — the only
matchup the game has. The strongest player is a **pure C-UCT MCTS** (no neural
net, no seed/RNG exploitation): offline self-play winrate is ~91–96% on the
iOS-faithful deal; measured **live** winrate is ~77–81% (see `IOS_CALIBRATION.md`
and `BATTLE_FUNCTION.md` for the sim-vs-real gap).

## The engine (one spec, two implementations, kept in parity)

- **`network_wars.py`** — the readable Python engine. The source-of-truth spec:
  topology (6×7 king-adjacency lattice), the iOS deal (every faction totals 20, 4
  fixed templates), reinforcement, the four bots, and the power-ratio battle
  (`BATTLE_FUNCTION.md`). bit-identical RNG (mulberry32).
- **`fast_engine.c` → `fast_engine.so` (via `fastnw.py`)** — the C hot path: the
  same rules plus the UCT tree search, ~1000× faster, used for all real search.
- **Parity gates:** `validate_fast.py` (C ↔ Python, bit-exact), `verify_port.py`
  + `verify_dump.js` (Python ↔ `../game.js`, the browser-playable JS engine).

## Run it

```sh
cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so
uv run python fmcts.py --games 120 --sims 3200 --wset C1 --c-puct 2.5   # one process
uv run python par_eval.py --games 1000 --sims 8000 --workers 9          # parallel winrate
```

- **`fmcts.py`** — plans with the C UCT search but applies each move to the *real*
  seeded Python game, so outcomes are genuine (the search never sees the game
  seed). Best config: ranked **C1** weights, `c_puct=2.5`, `sims=1600–3200`.
- **`par_eval.py`** — splits seeds across processes for fast winrate evals.

The single win% readout (live dashboard + JSONL) is **`winexp`** — the search's own
backed-up Q of the chosen move. It falls out of the MCTS (no separate calibration
model) and tracks real outcomes at AUC ~0.955.

A standalone from-scratch C variant of the same idea lives in **`../c/`**.

## Driving the real iOS app

`iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring and
runs live game series with the C-UCT engine. See `iphone_data/README.md`.

Deps are managed with `uv` (`pyproject.toml` / `uv.lock`); the only runtime
dependency is `numpy<2`. `fast_engine.so` is gitignored — rebuild with the `cc`
line above.
