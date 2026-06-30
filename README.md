# Network Wars

A faithful reproduction of Jim Rutt's **Network Wars** plus a strong AI player for it.
You (RED) fight four deterministic bots (GREEN, YELLOW, BLUE, PURPLE) for control of a
30-node graph; first faction to hold **24 nodes** wins. The whole game — board, deal,
bots, battle, reinforcement, win check, **and the search-based AI** — is one C file
(`solver/fast_engine.c`), compiled natively for headless play and to WASM for the browser.

## What's here

| Path | What it is |
|------|------------|
| `solver/fast_engine.c` | **The single source of truth.** All rules + board generation + the iOS-faithful deal + the four bots + the power-ratio battle + reinforcement + the open-loop **C-UCT MCTS** (no neural net). |
| `public/` | The **serverless browser game.** `fast_engine.c` compiled to WASM (`fast_engine.js`) runs the whole engine + search in a Web Worker; `index.html` is just the UI. No backend needed. |
| `solver/fmcts.py`, `solver/par_eval.py` | Headless self-play / parallel winrate evals (thin ctypes clients over the C engine). |
| `solver/server.py` | Optional stdlib HTTP server. Only needed for the live iOS `/grab` workflow — offline play needs no Python. |
| `solver/iphone_data/` | Capture, parse, and play the **real iOS app** via macOS iPhone Mirroring, and run live game series. |

## Docs

- **[`DESIGN.md`](DESIGN.md)** — the rules in prose; the source of truth for *what the game is*.
- **[`solver/README.md`](solver/README.md)** — the engine + solver in depth.
- **[`solver/BATTLE_FUNCTION.md`](solver/BATTLE_FUNCTION.md)** / **[`solver/IOS_CALIBRATION.md`](solver/IOS_CALIBRATION.md)** — how battle and the deal were fit to live data.
- **[`solver/iphone_data/README.md`](solver/iphone_data/README.md)** — driving the real app.
- **[`CLAUDE.md`](CLAUDE.md)** — project conventions.

## Quickstart

```sh
# Play in a browser (no backend) — serve the static frontend
cd public && python3 -m http.server      # -> http://127.0.0.1:8000/

# Or run the AI headless: build the native engine, then evaluate
cc -O3 -ffast-math -shared -fPIC solver/fast_engine.c -o solver/fast_engine.so
uv run python solver/validate_fast.py                          # regression gate
uv run python solver/par_eval.py --games 1000 --sims 8000 --workers 9
```

To rebuild the WASM frontend after editing `fast_engine.c`: `solver/build_wasm.sh`, then
`uv run python solver/validate_wasm.py` (bit-parity gate vs native). Python deps are
managed with `uv`; the only runtime dependency is `numpy<2`. `fast_engine.so` is
gitignored — rebuild with the `cc` line.

## The AI

A **pure C-UCT MCTS** (open-loop, ranked-C1 rollout baked in, `c_puct=2.5`) — no neural
net, no seed/RNG exploitation. Offline self-play winrate is **~94%** on the iOS-faithful
deal, and after battle/survivor recalibration a 100-game live run against the real app
**matches it** (~94%) — the old sim-over-predicts-live gap is closed
(`IOS_CALIBRATION.md`). An AlphaZero/PufferLib training path was tried and dropped — it
plateaued below the plain search.

The single win% readout (live dashboard + JSONL) is `winexp`: the search's own backed-up
Q for the chosen move, which tracks real outcomes with no separate calibration model.
