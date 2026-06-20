# Network Wars — Pure-MCTS RED Player: Report

**Status:** ~80% win rate vs the four deterministic bots, seed-free (no
RNG/seed exploitation). Engine + search in `c/nw.c`, driven by `c/run.js`.

This documents the current strategy, the empirical evidence behind every design
choice, and — most importantly — the assumptions and structural limits that
appear to cap the win rate around 80%.

---

## 1. Result summary

| player | win rate (seed-free) |
|--------|----------------------|
| safeExpand (the bots' own heuristic) | ~22% |
| denyLeader | ~32% |
| codexModalScout | ~50% |
| old JS flat MCTS (`mcts.js`) | ~58% |
| **this player (native multi-turn UCT)** | **~78–80%** |

Validated on 500-game runs with the default config
(`--tbudget 4000 --cpuct 2.5 --fpu 0.5 --selmean --minvis 80`):

| seed range (500 games) | win rate |
|------------------------|----------|
| 1..500 (dev) | **79.2%** |
| 1001..1500 (held-out, never tuned on) | 77.4% |
| 1..300 | 80.7% |

The held-out range confirms the result is genuine, not overfit.

The native engine plays ~1000× faster than the JS engine (8000 full greedy
games in ~88 ms; parity-validated: C greedy RED 22.9% vs JS `bestBotMove` RED
22.34% over 8000 games — only the dice stream differs).

---

## 2. The strategy

### Game structure that drives the design
Network Wars is a 5-faction snowball race to 24/30 nodes. RED is the player; the
four bots are **fully deterministic** functions of the board (each attacks the
weakest strictly-beatable neighbour). **The only randomness in the entire game
is the battle dice** — each flip is attacker-wins with p=0.55, repeated until the
attacker stack hits 1 or the defender hits 0. Reinforcement adds strength equal
to your largest connected component, spread over its border, so the game rewards
merging fragments into one blob and snowballing.

Because the bots are deterministic, the *only* thing worth searching is RED's own
action sequence under dice uncertainty.

### The search
A **multi-turn, open-loop UCT/PUCT** over RED actions:

- **Actions** at each node: every legal attack, plus a STOP action.
- **STOP edges span turns.** Taking STOP applies RED's reinforcement and runs all
  four bots (with sampled dice), so the child node is the start of RED's *next*
  turn. The tree therefore reasons across many turns, not just the current one.
  **This was the single biggest lever** (one-ply Monte Carlo ≈65% → multi-turn
  tree ≈77%).
- **Open-loop:** state is re-sampled (fresh dice) every traversal; children are
  keyed by action id. Each node's value averages over many dice futures — an
  unbiased estimate of E[win | this line of play].
- **Leaf evaluation:** a fast, aggressive rollout to the end of the game, scored
  binary win/loss.
- **Move played:** the **highest mean-value** root action (with a `minvis`
  floor), not the most-visited — this is better under high dice variance.
- **Fairness:** real battles use a per-board RNG stream; the search uses a
  *separate, independent* stream. The search never reads real dice, never
  fingerprints the seed. Its only inputs are the public board and the bots'
  public move rule.

### Tuned defaults
`tbudget 4000`, `cpuct 2.5`, `fpu 0.5`, `selmean` on, `minvis 80`, uniform prior,
`MAX_TURNS 120`.

---

## 3. Empirical findings (what moved the needle, what didn't)

Everything below is measured, not assumed.

**Helped:**
- Multi-turn tree (vs one-ply): ~65% → ~77%. *The* breakthrough.
- Mean-based root selection (`--selmean`): ~+1.5pp over most-visited.
- Budget, but only logarithmically (see §4).

**Did NOT help / actively hurt:**
- **Rollout policy quality is irrelevant.** A strong codex-`evalpos` rollout gave
  *identical* results to the cheap rollout (same 35/60 seeds) at 18× the cost.
  → The tree's value comes from search structure, not playout strength.
- **Policy priors hurt.** A uniform prior (73%) beat the cheap heuristic prior
  (68.5%); the strong `evalpos`-based prior was buggy/too slow (`--sprior`).
- **Positional leaf eval hurt.** Replacing rollouts with an `evalpos` logistic
  (`--leafeval`) dropped to ~70–72% — miscalibrated.
- **Discouraging STOP hurt** (`--stoplogit` negative: 74–76%). The tree's own
  stop decision is valuable; forcing aggression there is worse than letting it
  decide (even though aggression helps *inside* rollouts).
- **Raising the rollout capture-prob floor hurt** (76% → 69%). The snowball
  rewards aggression; the cheap rollout already attacks until no legal move.

---

## 4. Budget / time scaling (the ceiling, measured)

200-game sweep (seeds 1..200), default config, x = sims per decision:

| budget | win % | ms/move (1 core) |
|--------|-------|------------------|
| 125 | 55.5 | 4 |
| 250 | 68.5 | 8 |
| 500 | 66.0 | 17 |
| 1000 | 72.0 | 32 |
| 2000 | 78.0 | 56 |
| **4000** | **84.0** | **128** |
| 8000 | 81.0 | 250 |
| 16000 | 80.5 | 481 |

Win rate rises ~linearly in **log(budget)** up to ~b2000–4000, then is **flat**:
8000 and 16000 do not beat 4000 (the spread is 200-game noise, ±~3.5pp, around an
~81% plateau). Per-move time scales **linearly** with budget (~0.03 ms/sim), so
~80% costs ~0.1 s/move and **no amount of extra compute per move goes higher**.

This is the key diagnostic: the wall is *not* a search-quantity problem.

---

## 5. Known issues & assumptions that may be capping the ceiling

Ordered roughly by how likely each is to matter.

### 5.1 Irreducible dice variance (hard floor)
Some boards are unwinnable on the *realized* dice no matter how well RED plays.
The dice-known "portfolio oracle" (best of 7 strategies, picking per actual dice)
tops out at ~92%. A fair player must commit before seeing the dice, so its
ceiling is strictly below 92% and plausibly near 80–85%. **Part of the gap from
80% is simply not recoverable by any policy.** This bounds how much the items
below can buy.

### 5.2 No policy prior → high effective branching factor
The search uses a **uniform prior**, so simulations spread roughly evenly over
all legal moves. That makes budget buy depth only *logarithmically* (§4). The
reason we use uniform is empirical (§3): every heuristic prior we tried was worse.
But that means the search has **no good sense of "where to look,"** so it can't
reach the effective depth needed to resolve some multi-turn tactics. A genuinely
good (learned) prior would lower the effective branching factor and bend the
budget curve upward — this is the most likely single lever, but it requires a
prior that beats uniform, which our hand-built ones did not.

### 5.3 Rollout-to-terminal value: noisy and policy-biased
Leaves are scored by a single cheap rollout to the end. This is high-variance and
carries the bias of a ~40%-strength playout policy. Surprisingly, **improving the
rollout policy did nothing** (§3), which suggests the *binary terminal signal*,
averaged over enough visits, is "good enough" relative to the other bottlenecks —
but it also means there's no calibrated value to distinguish near-equal lines. A
*trained, calibrated* value head (different from a better rollout *policy*) is the
untested version of this lever; our hand-tuned static eval was miscalibrated and
hurt, so the bar is real.

### 5.4 Open-loop state blur
In open-loop UCT a node represents an **action sequence**, and its value averages
over the many different states reachable by that sequence under different dice.
This conflates "this move is good if the dice cooperate" with "this move is good
on average." A **closed-loop** formulation with explicit chance nodes — e.g.
bucketing each RED attack into {capture, fail} outcomes with expected strengths —
would give the tree sharper, state-specific value estimates. Untested; a
plausible few-percent lever, at the cost of a branchier tree.

### 5.5 Re-plan-per-attack with no tree reuse
RED re-plans from scratch before *every* attack within a turn (a turn has ~5–10
attacks). The tree built for attack *k* is discarded before attack *k+1*. This is
correct (it uses real dice feedback) but wasteful: warm-starting / re-rooting the
subtree would give several× more *effective* budget for the same compute. Given
budget gains are only logarithmic, this mostly helps **latency**, not win rate —
but it would make higher effective budgets affordable for "fast turns."

### 5.6 `MAX_TURNS = 120` cap
Games unresolved by turn 120 are scored as non-wins (real wins happen by ~turn 8;
this also caps rollout length and kills a slow-tail pathology). The assumption is
that no real win occurs past turn 120; a tiny sanity check supports it (win rate
unchanged vs the uncaught 300-turn cap), but it is an assumption.

### 5.7 Single-core per-move latency
The implementation parallelizes across *games* (for benchmarking), not within a
single decision. For a live game, one move's search is single-threaded
(~0.1 s at b4000). Root-parallelizing one decision across the 10 cores would cut
latency ~10× — relevant to "fast turns," not to the win-rate ceiling.

### 5.8 Selection/tuning assumptions
- `selmean` + `minvis` (the mean floor) was tuned at b2000–4000; `minvis` is hand-
  scaled with budget. A poorly chosen `minvis` at very low/high budget can pick a
  lucky low-visit action or over-filter. Mildly fragile.
- `cpuct`/`fpu` were tuned on the dev set; the differences between nearby values
  are within noise, so they are unlikely to be far off, but they are not
  rigorously optimized.

### 5.9 Modelling assumptions (fairness-critical, believed correct)
- **Bots are perfectly deterministic and known.** The C bot logic is a 1:1 port
  of `game.js` and parity-validated in aggregate. If the real game's bots ever
  differ (e.g. the iOS app), the search would be planning against the wrong
  opponent.
- **Board distribution** is generated in JS by the same `buildBoard` as `sim.js`
  and piped in, so it matches the benchmark exactly. The search itself never
  needs board-gen.
- **RNG independence** (no cheating): real-battle and rollout RNG are separate
  streams. This is the core fairness guarantee; if they were ever coupled, the
  win rate would be illegitimate.

### 5.10 Measurement noise
Most tuning was on 200–300-game sets (±2.5–3.5pp). Some reported deltas
(e.g. b4000 = 84% on 200 games vs 79.2% on 500) are partly noise. Headline
numbers use 500-game runs; sweep shapes are reliable, individual sweep points are
not.

---

## 6. Most promising paths beyond ~80%

1. **Learned policy + value net (AlphaZero-style).** Feed a trained net into the
   already-wired `--sprior` (prior) and `--leafeval` (value) hooks. Attacks both
   §5.2 and §5.3 at once. ~1.5–2 days incl. C↔Torch plumbing; estimated +3–8pp
   *if* the net beats uniform/heuristic baselines (≈60% odds, bounded by §5.1).
2. **Closed-loop chance nodes for RED attacks** (§5.4). Sharper value, branchier
   tree; a self-contained C change.
3. **Tree reuse + root parallelism** (§5.5, §5.7). Primarily latency, enabling
   higher effective budget per move within a "fast turn" budget.

The honest bottom line: pure MCTS is **converged** at ~80% — more compute is
flat. Crossing it needs a better *model* (prior/value), and some of the remaining
gap to the oracle's 92% is dice variance no policy can beat.
