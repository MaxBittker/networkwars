# Network Wars — RL policy (PufferLib)

PPO policy for RED, trained with [PufferLib](https://puffer.ai) 3.0 against the
deterministic bots. `network_wars.py` is a Python port of `../game.js` with
bit-identical RNG (mulberry32), verified game-for-game against the JS engine,
so winrates here are directly comparable to `node ../sim.js`.

## Results

Best model: `policy_cnn_v5.pt` — **51.3% argmax winrate** over 600 held-out
games (seeds 1–200, 5001–5200, 9001–9200). Baselines on seeds 1–200
(`node sim.js 200`): randomAll 33.0%, greedyWeakest 27.0%, cautiousExpand
21.0%, safeExpand 19.5%.

Model history (combined argmax winrate on held-out seeds):

| model | recipe | winrate |
|-------|--------|---------|
| v1 `policy_final.pt` | MLP, γ=0.97, ent 0.001, 10M steps | 44.0% |
| v2 (discarded) | CNN, γ=0.99, ent 0.001 — entropy collapsed at ~7M | ~37% |
| v3 `policy_cnn_v3.pt` | CNN, γ=0.99, ent 0.01, lr 0.008, 25M | 46.5% |
| v4 `policy_cnn_v4.pt` | v3 + component-aware obs, 25M | 47.3% |
| **v5 `policy_cnn_v5.pt`** | **v4 fine-tuned 8M @ ent 0.002, lr 0.003** | **51.3%** |
| v6 (discarded) | v5 fine-tuned again @ ent 0.0005 — regressed | 45.8% |

Lessons: the CNN needs the ent=0.01 exploration floor to avoid collapse, and a
single low-entropy fine-tune rung converts that exploration into ~4pp of
winrate — but a second rung overshoots. (v1–v3 checkpoints used an old 547-dim
observation and the now-removed `v1_snapshot/` frozen evaluator; they are no
longer runnable.)

## Files

- `network_wars.py` — engine port + Gymnasium env. Obs: 6×6 grid (owner one-hot,
  strength, exists, in-largest-component) + globals (counts, turn, per-faction
  largest-component sizes, red border size) + 289-bit legal-move mask. Action:
  `Discrete(289)` = 36 cells × 8 directions + end-turn. One step = one battle.
- `policy.py` / `policy_cnn.py` — MLP and CNN policies; both mask illegal
  actions inside `forward`, so the trainer never needs mask support. The CNN
  feeds the mask in as 8 per-direction legality planes and emits attack logits
  from a spatial 1×1-conv head.
- `train.py` — PPO via `pufferlib.pufferl` (CPU, multiprocessing vecenv).
- `evaluate.py` — plays fixed seeds, reports winrate.
- `verify_dump.js` / `verify_port.py` — JS↔Python engine parity check
  (400 games must match winner/turns/counts exactly).

## Reproduce

```sh
uv sync
uv run python verify_port.py                     # engine parity (optional)
# v3-equivalent base run (~2h on an M-series CPU):
uv run python train.py --timesteps 25000000 --policy policy_cnn \
    --gamma 0.99 --lr 0.008 --ent-coef 0.01 --out base.pt
# low-entropy fine-tune (the +4pp step):
uv run python train.py --timesteps 8000000 --policy policy_cnn \
    --gamma 0.99 --lr 0.003 --ent-coef 0.002 --resume base.pt --out final.pt
uv run python evaluate.py final.pt --policy policy_cnn
```

Pinned deps: pufferlib 3.0.0 requires `numpy<2`, and its prebuilt C advantage
kernel on macOS matches `torch==2.10.0` exactly (other torch versions fail with
missing-symbol errors at import).
