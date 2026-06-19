# AlphaGo-style bot for Network Wars

MCTS guided by a learned policy+value net, playing RED against the 4 fixed
deterministic bots. There is **no RED-vs-RED**: every game (training and eval)
is RED vs the bots — the only matchup that exists. "Self-play" below is the
AlphaZero sense: the bot generates its own training data by playing the bots
with search.

## Why this shape

From RED's seat the opponents are fixed, so it's a **single-agent stochastic
planning problem** — the only randomness is the battle dice. So:

- `mcts.py` runs **open-loop PUCT MCTS** over RED's actions (each action = one
  attack or end-turn). Bots run inside the end-turn transition, so the tree
  looks many turns ahead. No rollouts — leaves are evaluated by the value net.
- Dice are sampled with a **private RNG independent of the game seed** (no seed
  exploitation); statistics average over chance across simulations.

## Pipeline

1. **Distill the expert** (AlphaGo SL step). modalScout (~68% JS heuristic) is
   the expert. Because `network_wars.py` is bit-identical to `../game.js`, we
   dump modalScout games in JS and *replay* them in Python for consistent obs:
   ```sh
   node dump_expert.js 5000 200000 > expert.jsonl
   uv run python replay_expert.py expert.jsonl --out expert
   uv run python train_sl.py --data expert --init policy_cnn_v5.pt --epochs 12 --out sl_cnn.pt
   ```
2. **Play with search**:
   ```sh
   uv run python mcts.py sl_cnn.pt --games 150 --sims 120
   ```
3. **AlphaZero iteration** (optional, to push past the expert):
   ```sh
   uv run python selfplay.py sl_cnn.pt --games 1500 --sims 100 --seed-base 300000 --out sp0
   uv run python train_az.py --sp sp0 --expert expert --init sl_cnn.pt --epochs 6 --out az1.pt
   uv run python mcts.py az1.pt --games 150 --sims 120
   ```
   Repeat with `az1.pt` as the new base, growing the self-play set each round.

## Rules change 2026-06-19

game.js switched to a **7×6 (42-cell) lattice** and **bimodal initial
strengths** (50%→1, else 4..8) to match the real iOS app. This invalidated the
old 6×6 checkpoints (obs/action dims changed: 42 cells, 337 actions, OBS_DIM
685) — all nets were retrained from scratch. The new rules are much harder
(everyone starts with strong nodes), so winrates dropped: modalScout 68.7%→52%,
SL argmax 62%→43%, MCTS+SL 68%→53.3% (still beats the heuristic). Re-port +
re-distill steps below; `verify_port.py` passes (400/400).

## Results (held-out seeds 1..N, no seed exploitation)

### Final rules (7×6, bimodal strengths, CLUSTERED ownership) — 2026-06-19
| bot | winrate | sample |
|-----|---------|--------|
| modalScout heuristic | 49.7% | 300 |
| `sl_cnn` argmax | 41.0% | 200 |
| **MCTS + `sl_cnn`** | **57.5%** | 120 (seeds 1..120) |

| MCTS + `az1` (1 self-play iter) | 55.8% | 120 (seeds 1..120) |

MCTS adds +16.5pp over argmax and beats the heuristic by ~8pp — clustered
territories give the search more structure to exploit. az1 (one self-play iter
from the epoch-8 sl base, small 19k-state buffer, 0.25 expert mix) was flat
within noise — needs a converged base + larger self-play to help. (Intermediate
uniform-scatter+bimodal variant: modalScout 52%, MCTS+sl 53.3%, before game.js
switched ownership to clustered `assignOwnership`.)

### Old rules (6×6, uniform 1..5) — historical

| bot | winrate | sample |
|-----|---------|--------|
| v5 CNN argmax | 51% | 600 |
| MCTS over v5 (uncalibrated value) | ~52% (no lift) | 60 |
| `sl_cnn` argmax (distilled modalScout) | 62% | 200 |
| MCTS + `sl_cnn` | 64.0% | 150 (seeds 1..150) |
| MCTS + `sl_cnn`, sims 120 → 300 | 68.3% → 68.8% (saturates) | 60 / 80 |
| MCTS + `az1` (self-play iter 1) | 67.3% | 150 (seeds 1..150) |
| **MCTS + `az2` (self-play iter 2)** | **68.0%** | 150 (seeds 1..150) |
| reference: modalScout heuristic | ~68% | — |

AlphaZero trajectory on identical seeds 1..150: sl 64.0% → az1 67.3% (+3.3) →
az2 68.0% (+0.7). Real gains, but diminishing fast and plateauing at the
modalScout level (~68%).

Key findings:
- Search needs a **calibrated value** + **good priors**: MCTS over v5's raw PPO
  value adds nothing; over the distilled net it adds ~+6pp.
- **More sims doesn't help** past ~100 — the net quality is the ceiling, so the
  way up is better nets (AlphaZero iterations), not deeper search.
- **One self-play iteration helped**: on identical seeds 1..150, `az1` beat
  `sl_cnn` 67.3% vs 64.0% (+3.3pp). The AlphaZero loop works; more/larger
  iterations are the path to push further.

## To push toward 80%

- Larger self-play iterations (≥2000 games), several rounds, decaying the
  expert-mix fraction as the net surpasses modalScout.
- Fix value-head overfit: split train/val **by game** (states in one game share
  a label), early-stop, add dropout/weight-decay, or use a smaller value head.
- Higher sims during self-play data-gen for higher-quality visit-count targets.
- Caveat: a dice-blind ceiling likely applies — see `memory/mcts-results.md`.
