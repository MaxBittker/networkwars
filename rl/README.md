# Network Wars — search & learning for RED

Everything here plays **RED against the four fixed deterministic bots** — the
only matchup the game has. The shared foundation is `network_wars.py`, a Python
port of `../game.js` with bit-identical RNG (mulberry32), verified game-for-game
against the JS engine (`verify_port.py`, 400/400), so every win rate below is
directly comparable to `node ../sim.js`.

Board rules match the iOS app as of 2026-06-19: a **7×6 (42-cell) lattice**,
**bimodal** initial strengths (50%→1, else 4..8), **clustered** ownership. One
step = one battle; observation is a 42-cell grid + globals + a 337-bit legal-move
mask (`OBS_DIM 685`).

## Two approaches

### 1. Multi-turn UCT MCTS, seed-free — **~80%** (current best)

A heuristic-rollout UCT search over RED's action sequence, with a STOP edge that
runs all four bots so the tree spans many turns. No neural net, **no seed/RNG
exploitation** (search rollouts use a private RNG independent of the game seed).
This is the strongest player and the headline result.

- **`../c/`** — standalone from-scratch C engine + search, ~1000× the JS engine,
  ~78–80% on held-out seeds. See `../c/README.md` for the design, fairness
  argument, and tuned config.
- **`fast_engine.c` + `fastnw.py` + `fmcts.py`** — the same hot path as a ctypes
  shared lib driving the Python engine, used to tune the ranked-rollout weight
  sets. `fmcts.py` plans with the C UCT search but applies moves to the *real*
  seeded Python game, so outcomes are genuine.

  ```sh
  cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so
  uv run python fmcts.py --games 120 --sims 3200 --wset C1 --c-puct 2.5
  ```

### 2. Learned policy+value MCTS (AlphaZero-style) — ~57%

Distill the modalScout heuristic into a CNN, then guide PUCT MCTS with it and
push further with self-play. Beats the heuristic but plateaus well below the
seed-free UCT search above. Full pipeline, results, and lessons in
**`ALPHAGO.md`**.

- `policy_cnn.py` — CNN policy/value net (masks illegal actions in `forward`).
- `dump_expert.js` → `replay_expert.py` → `train_sl.py` — distill modalScout
  into `sl_cnn.pt` (SL step).
- `mcts.py` — open-loop PUCT MCTS over the net (leaves = value head, no rollouts).
- `selfplay.py` → `train_az.py` — AlphaZero self-play iterations.
- `gen_data.py` / `train_value.py` — optional calibrated win-probability value
  head (BCE-fine-tuned).
- `evaluate.py` — fixed-seed win-rate harness (also provides the `_EnvShim`
  shared by the scripts above).

## Reproduce

```sh
uv sync
uv run python verify_port.py        # engine parity vs JS (optional)
# strongest player (also runnable standalone from ../c/):
cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so
uv run python fmcts.py --games 120 --sims 3200 --wset C1 --c-puct 2.5
# learned-net line — see ALPHAGO.md for the SL + self-play steps.
```

Pinned deps: pufferlib 3.0.0 requires `numpy<2`, and its prebuilt C advantage
kernel on macOS matches `torch==2.10.0` exactly (other torch versions fail with
missing-symbol errors at import). Managed with `uv` (`pyproject.toml`/`uv.lock`).

Regenerable artifacts (`*.pt`, `*.npy`, `*.log`, `expert.jsonl`, `fast_engine.so`)
are gitignored — rebuild them from the steps above.
