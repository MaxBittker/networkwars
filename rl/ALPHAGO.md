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

## "Lose less" tuning sweep (2026-06-20, no phone — offline self-play)

Question: can we tune the pure C-UCT to LOSE LESS (vs win more)? Live-game
analysis showed losses are decided rounds 0-3 and red collapses fast (~7 turns,
wiped to ~1-2 nodes). Tested the implied levers offline via `tune_lossless.py`
(paired seeds, vs the confirmed-deterministic bots), base sims=1600, 300 games:

| config            | winrate    | note                                   |
|-------------------|------------|----------------------------------------|
| nroll3            | 76.0% ±2.5 | leaf-value variance reduction (best, within noise) |
| adaptive_behind   | 75.3% ±2.5 | switch to safety rollout when Q<0.45   |
| **baseline**      | **75.0%**  | flat 1600, ranked C1, c_puct 2.5, policy 1 |
| frontload_extra   | 73.7% ±2.5 | **3× sims in rounds≤3 — no help**      |
| frontload_neutral | 71.3% ±2.6 | big opening / small late — worse       |
| cpuct4            | 68.0% ±2.7 | confirms c_puct 2.5 near-optimal       |
| policy2_safety    | 67.7% ±2.7 | global safety-aware rollout much worse |

**Conclusion: losses are NOT reducible by tuning.** Front-loading opening sims
fails even with 3× extra compute → the early losses are deal/dice-determined, not
search-starved. Playing cautiously when behind (adaptive / global safety) does not
rescue games — once behind vs the greedy bots you lose. The ~22% loss rate is
structural (bad deals + battle-dice variance). The only nominal gain is `nroll`
(noisy-value reduction), consistent with the value estimate being the soft spot —
under confirmation at 500 games. Practical takeaway: don't chase loss-reduction
via search/policy knobs; the lever, if any, is a better leaf VALUE (calibrated /
lower-variance), not more or differently-allocated search.

Confirmation at 500 games (base 1600) — **nroll is NOISE too**: baseline 72.8%±2.0
(364/500), nroll2 74.2% (371/500), **nroll3 72.8% (364/500) — identical to
baseline**. The n=300 nroll bumps (76.0%) were favorable-seed noise; with more
games the gain vanishes. So NO search/policy/value-variance lever beats baseline.
Sims-scaling (REVISED, iter 4): per-DOUBLING is flat-within-noise (1600≈3200≈6400
≈73–74%), but 10× IS a real cumulative gain — on identical seeds 1–160 baseline
@1600 = 71.25% vs @16000 = **75.6% (+4.4%)**. So sims help with strong diminishing
returns, plateauing ~16k (matches the prod config & the "~78% plateau" note). The
ceiling is ~76–78%, set by rollout-POLICY quality + dice/deal luck. nroll
(more rollouts/leaf) does NOT lower it — at high enough sims the tree already
averages noisy leaves. Only a fundamentally better/calibrated value could move it,
and learned-value already hit its own ceiling (see above + memory). Net: "improve
the AI by tuning the C-UCT" is exhausted; the remaining path is a better value
function, not search. [@6400 sims baseline-vs-nroll3 confirmation was still running
at write time — expected to show the same no-difference.]

## Fitted value-leaf (2026-06-20, iter 3) — speed win, not strength win

Pursued the one remaining lever from the lose-less sweep: a better leaf VALUE.
Fit a logistic win-probability on 19.4k C-UCT self-play states (cheap features:
red_n, margins vs strongest/avg enemy, strength margin, largest red component,
fracture, turns) tagged with eventual outcome — `gen_value_data.py`, weights in
`value_leaf_w.npy`. The fit is well-calibrated: AUC 0.958, logloss 0.184,
calibration deciles track (0.5→0.54, 0.7→0.77, 0.9→0.99).

Wired it into the engine as a truncated-rollout leaf (`rollout_v` in
fast_engine.c: roll K red-turn cycles then return the heuristic; `set_leaf_trunc`,
`set_value_weights`). Result (400 paired games, sims 1600):

| leaf eval        | winrate    | time  |
|------------------|------------|-------|
| full rollout     | 73.2% ±2.2 | 777s  |
| vtrunc2          | 71.5%      | 353s (2.2×) |
| **vtrunc4**      | 73.5% ±2.2 | 602s (1.3×) |
| vtrunc8          | 71.5%      | 735s  |
| vtrunc0 (static) | ~43% (n30) | — (too crude, no tactics) |

**vtrunc4 ties baseline winrate at ~1.3–2× less compute — a speed/latency win, NOT
a strength win.** The calibrated value is as good as the rollout it replaces, so
swapping is winrate-neutral. Confirms (3rd independent angle) the ~73% ceiling is
the rollout-POLICY quality + dice/deal luck, not the value estimator. Pure static
eval (vtrunc0) is much worse — a few plies of real rollout are needed for tactics.

**Genuinely useful spinoffs:** (1) the truncated leaf is a clean ~1.5× search
speedup at equal strength (matches the old "value-leaf = 2× latency" note); (2) the
fitted logistic is a far better-CALIBRATED win-probability than the pessimistic
backed-up rollout Q — use it for the dashboard win% readout (answers the original
"win confidence is poorly calibrated" question). To raise the actual winrate ceiling
you'd need a stronger red ROLLOUT POLICY (ranked C1 already tuned; safety was worse)
— search/value/variance levers are all exhausted.

## Ceiling + value-leaf at production sims (iter 4)

Probed whether ~73% (offline, 1600 sims) is the real ceiling or just under-powered
search. On identical seeds 1–160 (huge seed variance — shards swing 70–85%):
- baseline @1600  = 114/160 = 71.3%
- baseline @16000 = 121/160 = 75.6%  (+4.4% from 10× sims; gentle climb, plateaus)
- **vtrunc4 @16000 = 124/160 = 77.5%**  (value-leaf ≥ baseline, ~1.3× faster)

So the true ceiling is ~76–78% at the production 16k-sim config — sims help with
strong diminishing returns and the prod setting is justified. The fitted value-leaf
(vtrunc4) matches-or-slightly-beats full rollout at every sim count AND runs faster,
making it the one strictly-reasonable change — but the win is speed, not strength;
the ~22% loss rate is irreducible deal+dice luck. No lever raises the ceiling.

**Bottom line after 4 iterations:** the C-UCT plays near-optimally vs the (weak,
deterministic) bots; ~76–78% is the structural ceiling. Shippable artifacts:
(1) `value_leaf_w.npy` — a calibrated win% (AUC 0.958) for the DASHBOARD readout
(replaces the pessimistic rollout Q); (2) vtrunc4 leaf for ~1.3× faster equal-
strength search if latency ever matters (it doesn't on the phone — taps dominate).

## Value-greedy rollout policy (iter 5) — also ties

Implemented the last principled lever: RED_ROLLOUT_POLICY=3 = pick the rollout
attack maximizing the fitted leaf value (prob-weighted expected outcome via the
capture tables) instead of the hand-tuned ranked heuristic — using the calibrated
value to make red PLAY better in sims, not just evaluate. (`value_greedy_move` in
fast_engine.c.) Paired, seeds 1–160, sims 1600: baseline 114/160 vs
valpolicy_trunc4 114/160 — **EXACT TIE** (the +7.5% seen on the 40-game subset was
noise). And it's ~2.5–5× slower. So a value-driven rollout policy does not beat the
ranked heuristic. Lever exhausted.

**FINAL (5 iterations):** every search/policy/value lever — sim count & allocation,
c_puct, nroll, behind-awareness, rollout policy (ranked/safety/greedy/value-greedy),
and leaf value (rollout/truncated/fitted-logistic) — TIES or LOSES vs baseline. The
C-UCT plays near-optimally vs the weak deterministic bots; the ~76–78% ceiling (at
prod 16k sims) is structural deal+dice luck. The AI cannot be meaningfully improved
by these means. Useful artifacts: `value_leaf_w.npy` (calibrated win% for the
dashboard) and the vtrunc4 leaf (~1.3× faster, equal strength).

## Irreducibility proof (iter 6) — the ceiling is compute-saturated at ~16k sims

Per-seed analysis (`per_seed.py`) settles whether the ~78% ceiling is search-limited
or irreducible. Seeds 1-200, baseline: @1600 = 149/200 = 74.5% (51 losses). Re-ran
those 51 losing seeds at higher sims:
- @16000: **19/51 (37%) flip to WINS** — many losses ARE search-recoverable, not dice luck
- @32000: 18/51 flip — **SATURATED** (no gain over 16k)
- control: 31/32 winners hold @16000 (churn is real but small at the margin)

So: (1) more sims genuinely recovers ~37% of low-sim losses, BUT (2) this saturates
by 16000 — the production sim count. Going above 16k recovers nothing more. The net
winrate (~78%) = loser-recoveries minus churn (the E[win]-optimal move sometimes
loses to a seed's specific realized dice — irreducible, since red can't see future
dice in the real closed-loop game). **CONCLUSION: 78% is the compute-saturated
ceiling; the prod 16k config is optimal; the remaining ~22% losses are irreducible.
No lever (5 iters) and no extra compute moves it. Tuning is definitively exhausted.**
