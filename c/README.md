# Native MCTS for Network Wars

A from-scratch C reimplementation of the Network Wars engine plus a Monte-Carlo
Tree Search player for RED. It is ~1000× faster than the JS engine and reaches
**~80% win rate** against the four deterministic bots, with **no seed / RNG
exploitation**.

## Why this is fair (no cheating)

The only randomness in the game is the battle dice (each flip is attacker-wins
with p=0.55); the four bots are fully deterministic functions of the board.

- **Real battles** use a per-game RNG stream seeded from the board seed.
- **Search rollouts** use a *separate, independent* RNG stream.

The search never reads the real battle stream, never fingerprints the seed, and
never inspects future dice. Its only inputs are the public board state and the
bots' public (deterministic) move rule — exactly what a human watching the game
can see. Boards are generated in JS by the *same* `buildBoard` used by `sim.js`,
so the win rate is measured over the identical board distribution as the
existing benchmark.

## How it works

The key idea: because the bots are deterministic, the only thing worth searching
is RED's own action sequence under dice uncertainty. The player is a
**multi-turn, open-loop UCT/PUCT**:

- The tree branches on RED actions (each legal attack + a STOP action).
- A STOP edge applies RED's reinforcement and runs all four bots (with sampled
  dice), landing the search on RED's *next* turn — so the tree spans many turns,
  not just the current one. This was the breakthrough that took win rate from
  ~65% (one-ply Monte Carlo) to ~78-80%.
- Open-loop: state is re-sampled every traversal (fresh dice), so each node's
  value averages over many dice futures — an unbiased estimate of E[win | line].
- The leaf is evaluated by a fast aggressive rollout to the end of the game
  (binary win/loss). Rollout *policy quality turned out not to matter* — a strong
  (codex `evaluatePosition`) rollout gave identical results at 18× the cost — so
  the cheap one is used.
- The played move is the **highest mean-value** root action (beats most-visited
  under the high dice variance).

Things that were tried and did **not** help: policy priors (both a cheap
heuristic and the strong `evalpos` one) hurt vs a uniform prior; truncated
rollouts with a positional leaf eval hurt (miscalibrated); discouraging STOP
hurt (the tree's own stop decision is valuable); raising the rollout
capture-probability floor hurt (the game rewards aggression).

## Build & run

```sh
cc -O3 -march=native -o nw nw.c -lpthread -lm
node run.js <games> <seedBase> [flags...]
```

`run.js` generates the boards and pipes them to `./nw`, which plays them in
parallel across threads and prints `wins games winrate`.

Tuned defaults (the ~80% config) are baked in; this is equivalent:

```sh
node run.js 500 1 --tree --tbudget 4000 --cpuct 2.5 --fpu 0.5 \
    --selmean --minvis 80 --threads 10
```

Useful flags: `--tbudget N` (sims per decision; win rate climbs ~log with N),
`--cpuct`, `--fpu`, `--selmean`/`--minvis N` (mean-based root selection),
`--threads N`, `--greedy` (RED plays the bot heuristic — used for engine-parity
validation against JS).

## Results (seed-free, vs the 4 deterministic bots)

| player                         | win rate |
|--------------------------------|----------|
| safeExpand (bot heuristic)     | ~22%     |
| denyLeader                     | ~32%     |
| codexModalScout (seeds 1..500) | ~50%     |
| old JS flat MCTS (`mcts.js`)   | ~58%     |
| **native multi-turn UCT**      | **~78-80%** |

Default config (`--tbudget 4000 --cpuct 2.5 --fpu 0.5 --selmean --minvis 80`),
500-game runs:

| seeds (500 games) | win rate |
|-------------------|----------|
| 1..500 (dev)      | **79.2%** |
| 1001..1500 (held-out) | 77.4% |
| 1..300            | 80.7% |

The held-out range was never used for tuning, so the ~77-79% is genuine (no
overfitting). Win rate climbs ~logarithmically with `--tbudget` (b2000 ≈ 78%,
b4000 ≈ 80%, b8000 ≈ +1%), so b4000 is the speed/strength sweet spot. `--flat`
selects the old per-attack flat search (~65%).

Engine parity validated: C greedy RED = 22.9% vs JS `bestBotMove` RED = 22.34%
over 8000 games (within noise; only the dice stream differs).
