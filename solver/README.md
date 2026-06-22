# Network Wars — engine + solver

One implementation of the whole game, in C, with thin clients around it. Everything
plays **RED against the four fixed deterministic bots** — the only matchup the game
has. The player is a **pure C-UCT MCTS** (no neural net, no seed/RNG exploitation):
offline self-play winrate is ~91–96% on the iOS-faithful deal; measured **live**
winrate is ~77–81% (see `IOS_CALIBRATION.md` and `BATTLE_FUNCTION.md` for the
sim-vs-real gap).

## The engine (single source of truth)

- **`fast_engine.c` → `fast_engine.so`** — the only implementation of board
  generation + the iOS deal, the four bots, the power-ratio battle
  (`BATTLE_FUNCTION.md`), reinforcement, win check, and the open-loop C-UCT search
  (ranked **C1** rollout baked in). mulberry32 for the real seeded game; a private
  splitmix64 for search dice so the search never sees the real game's dice.
- **`fastnw.py`** — thin ctypes client: marshals `(owner, strength)` int32 arrays
  in/out, exposes `new_game`, the rule primitives, and `uct_search`. No rules here.
- **`network_wars.py`** — a readable `State`/`Node` shim that delegates every rule
  to the C engine, so the `iphone_data/` analysis tools keep a convenient object API.
- **`validate_fast.py`** — the regression gate: board/deal/battle invariants over
  1000 seeds + frozen golden-seed game outcomes (Python is now a client of C, so
  there is no separate bit-parity oracle).

## Run it

```sh
cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so
uv run python validate_fast.py                       # regression gate
uv run python fmcts.py --games 120 --sims 3200 --c-puct 2.5   # one process
uv run python par_eval.py --games 1000 --sims 8000 --workers 9 # parallel winrate
uv run python server.py                              # play in a browser
```

- **`fmcts.py`** — plans with the C UCT search but applies each move to the *real*
  seeded game (via the `network_wars` shim), so outcomes are genuine — the search
  never sees the game seed. Best config (baked into the engine): ranked C1 rollout,
  `c_puct=2.5`, `sims=1600–3200`.
- **`par_eval.py`** — splits seeds across processes for fast winrate evals.
- **`server.py`** — stdlib HTTP server implementing `/api/game/*`; the browser
  (`../public/index.html`) plays the same C engine over HTTP. Also exposes `/grab`
  to pull the live iOS-mirrored board into a new in-browser game.

The single win% readout (live dashboard + JSONL) is **`winexp`** — the search's own
backed-up Q of the chosen move. It falls out of the MCTS (no separate calibration
model) and tracks real outcomes at AUC ~0.955.

## Driving the real iOS app

`iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring and runs
live game series with the C-UCT engine. See `iphone_data/README.md`.

Deps are managed with `uv` (`pyproject.toml` / `uv.lock`); the only runtime
dependency is `numpy<2`. `fast_engine.so` is gitignored — rebuild with the `cc` line.
