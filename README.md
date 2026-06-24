# Network Wars

A faithful reproduction of Jim Rutt's **Network Wars** plus a strong AI player for it.
You (RED) fight four deterministic bots (GREEN, YELLOW, BLUE, PURPLE) for control of a
30-node graph; first faction to hold **24 nodes** wins. The whole game — board, deal,
bots, battle, reinforcement, win check — is one C implementation that both the browser
game and the search-based AI play through.

## What's here

| Path | What it is |
|------|------------|
| `public/index.html` | The browser game. A thin canvas client — it renders server state and posts actions; **no game logic lives in JS.** |
| `solver/fast_engine.c` | **The single source of truth.** All rules + board generation + the iOS-faithful deal + the four bots + the power-ratio battle + reinforcement + the open-loop **C-UCT MCTS** search (no neural net). |
| `solver/server.py` | Stdlib HTTP server (`/api/game/*`) that serves the browser game over the same C engine via ctypes. |
| `solver/fmcts.py`, `solver/par_eval.py` | Headless self-play / parallel winrate evals for the AI. |
| `solver/iphone_data/` | Tools to capture, parse, and play the **real iOS app** via macOS iPhone Mirroring, and to run live game series with the C-UCT engine. |

## Docs

- **[`DESIGN.md`](DESIGN.md)** — the rules, in prose. The source of truth for *what the
  game is*; if a rule there is wrong, fix it there first, then in the code.
- **[`solver/README.md`](solver/README.md)** — the engine + solver in depth.
- **[`solver/BATTLE_FUNCTION.md`](solver/BATTLE_FUNCTION.md)** / **[`solver/IOS_CALIBRATION.md`](solver/IOS_CALIBRATION.md)** —
  how battle and the deal were fit to ~3300 live battles, and the offline-vs-live gap.
- **[`solver/iphone_data/README.md`](solver/iphone_data/README.md)** — driving the real app.
- **[`CLAUDE.md`](CLAUDE.md)** — project conventions.

## Quickstart

The engine is a single C file. Build it, then either play in a browser or run the AI.

```sh
# 1. Build the engine
cc -O3 -ffast-math -shared -fPIC solver/fast_engine.c -o solver/fast_engine.so

# 2a. Play in a browser
uv run python solver/server.py            # -> http://127.0.0.1:8080/

# 2b. Or run the AI headless
uv run python solver/validate_fast.py                          # regression gate
uv run python solver/fmcts.py --games 120 --sims 3200 --c-puct 2.5
uv run python solver/par_eval.py --games 1000 --sims 8000 --workers 9
```

Python deps are managed with `uv` (`solver/pyproject.toml` / `uv.lock`); the only
runtime dependency is `numpy<2`. `fast_engine.so` is gitignored — rebuild with the `cc`
line above.

### Load a recorded position

The browser game can start from a saved board instead of a fresh deal:
`http://127.0.0.1:8080/?load=<file.json>`, where `<file.json>` is a board snapshot
(`{nodes:[{id,x,y,owner,strength}]}`) under `solver/iphone_data/`. This is how a position
recorded from a live game gets replayed in the sim.

## The AI

A **pure C-UCT MCTS** (open-loop, ranked-C1 rollout baked in, `c_puct=2.5`) — no neural
net, no seed/RNG exploitation. Offline self-play winrate is **~91–96%** on the
iOS-faithful deal. Measured **live** winrate against the real app is **~77–81%**; the sim
over-predicts live play, an open gap documented in `BATTLE_FUNCTION.md` and
`IOS_CALIBRATION.md`. (An AlphaZero/PufferLib training path was tried and dropped — it
plateaued below the plain search.)

The single win% readout (live dashboard + JSONL) is `winexp`: the search's own backed-up
Q for the chosen move, which tracks real outcomes at AUC ~0.955 with no separate
calibration model.
