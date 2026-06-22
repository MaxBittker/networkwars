# Calibrating the sim to the real iOS game

**TL;DR.** Our offline self-play winrate (~75%) was far below our live phone winrate
(~92%). Mining 100 live games revealed the sim diverged from the real iOS app in two
measurable ways: (1) the **initial deal** — the real game balances every faction to
exactly 20 total strength, the old sim dealt strengths i.i.d. (per-faction totals
swinging ±15); and (2) **battle resolution** — the real attacker wins far more
decisively than the engine's fixed-probability coin-flip, in a way that scales with the
*strength ratio*. Fix (1) is shipped and **closes the offline↔live gap entirely**: the calibrated sim now
scores **91.5%** offline (1000 games), matching the live **91.9%**. Fix (2) is partially
shipped (`ATTACKER_WIN_P 0.55→0.60`) with a better functional form proposed below (a
power-ratio duel, γ≈3.3), pending one more data-collection step.

Source data: `iphone_data/runs/series_20260620_2318.jsonl` (8 games) +
`series_20260621_200g.jsonl` (92 games) = 100 live C-UCT games, 91.9% decided.

---

## 1. The motivating gap

| Setting | Winrate | n | 95% CI |
|---|---|---|---|
| Offline self-play (old sim, p=0.55, i.i.d. deal), 8000 sims | 75.0% | 1000 | ±2.7% |
| **Live iOS phone**, 16000 sims | **91.9%** | 100 | ±5.3% |
| **Offline self-play (calibrated sim, p=0.60, balanced deal), 8000 sims** | **91.5%** | 1000 | ±1.7% |

A ~17-point gap, z>4 — not variance. Something about the sim was wrong. We checked every
engine heuristic; two diverged from reality. After fixing them the calibrated sim (91.5%)
agrees with live play (91.9%) — the gap is gone.

---

## 2. Finding 1 — the deal (SHIPPED)

### Data
Per-faction **total starting strength**, real vs. old sim:

| | mean total/faction | deal spread (max−min faction) |
|---|---|---|
| **Real** (99 openings) | ~20, **sd 0.8–2.1** | mean **0.3**, median **0** |
| **Old sim** (n=6000) | ~21, **sd 6.6** | mean **15.4**, median 15 |

- Real: **every faction starts at exactly 20**; board total always 100; 6 nodes each.
- Old sim: i.i.d. strengths (50%→1, else 4–8) → per-faction totals swing wildly. Only
  **3.5%** of sim deals were real-like (spread ≤6); **46%** were severely lopsided (≥16).
- Red is **not** advantaged in either world (red's edge over the average bot: +0.24 real,
  +0.16 sim — both negligible). The asymmetry is *between factions within a deal*, not toward red.

The real deal is fully specified: each faction's 6 nodes are one of **4 fixed templates**
(each summing to 20), at measured frequencies:

| template | freq (real) | freq (new sim) |
|---|---|---|
| `[1,1,1,5,6,6]` | 38.5% | 38.8% |
| `[1,1,1,1,8,8]` | 32.7% | 33.3% |
| `[1,1,4,4,5,5]` | 22.2% | 21.6% |
| `[1,3,4,4,4,4]` | 6.6% | 6.3% |

These reproduce the observed per-node strength marginals exactly (≈49% ones; 4/5/6/8 each
~11–14%; **no 7s**; rare 2/3).

### Confirmation
Splitting old-engine self-play by deal balance isolates the effect cleanly:

| deal type | winrate (8000 sims) | n |
|---|---|---|
| **Balanced** (spread ≤6, real-like) | **87.6%** | 210 |
| Mixed (the 1000-game baseline) | 75.0% | 1000 |
| **Unbalanced** (spread ≥16) | **69.0%** | 210 |

A **19-point swing from the deal alone**. Balanced-deal self-play (87.6%) lands next to
live play; real deals are even tighter (spread 0), closing the rest.

### Theory & fix
The old harness forced the agent to play ~half its games from lopsided deals that **cannot
occur** in the real game — often handing a *bot* a dominant start. That dragged the measured
winrate down and made the "75–78% plateau" largely an artifact. **Fixed:** `build_board` now
deals the 4 balanced templates. Verified: spread 0, board total 100, 6/faction, template
frequencies match within ~1%.

---

## 3. Finding 2 — battle resolution (p shipped; shape proposed)

### The engine's model
A battle is **iterated Bernoulli attrition**: each round, attacker wins w.p. `p` (defender
−1) or loses (attacker −1), until attacker hits its garrison (str 1) or defender hits 0.

### Data (1629 clean battles — both nodes untouched that round, strengths exact)
Overall real capture rate **72.6%**. Two patterns break the fixed-`p` model:

**(a) Implied `p` rises with the attacker's edge — no single `p` fits.**

| matchup | n | empirical | implied single-p |
|---|---|---|---|
| (3,3) equal | 139 | 44% | 0.58 |
| (2,2) equal | 73 | 47% | 0.68 |
| (3,2) | 130 | 81% | 0.72 |
| (3,1) | 59 | 98% | 0.87 |

**(b) It's the *ratio*, not the *margin*.** Three matchups all at margin **+2**:

| matchup | ratio | empirical capture |
|---|---|---|
| (3,1) | 3.0 | 98% |
| (4,2) | 2.0 | 90% |
| (5,3) | 1.67 | 82% |

A margin-based coin-flip cannot represent ratio dependence. The real combat is **far more
strength-decisive** than ±1 coin flips.

### Model fits (MLE over the 1629 battles, by AIC; lower = better)

| model | params | logL | AIC |
|---|---|---|---|
| const-p attrition (current engine) | p=0.60 | −680.5 | 1362.9 |
| proportional `a/(a+d)` per round | 0 | −673.4 | 1346.8 |
| power-ratio attrition (per-round `aᵞ/(aᵞ+dᵞ)`) | γ=0.91 | −672.9 | 1347.7 |
| logistic-in-margin per round | 2 | −680.3 | 1364.5 |
| single-shot logistic | 2 | −666.6 | 1337.2 |
| single-shot power-ratio | γ=3.17 | −650.9 | 1303.9 |
| **single-shot power-ratio + handicap** | **γ=3.3, c=1.14** | **−649.6** | **1303.2** |

**Winner (ΔAIC ≈ 60 over the current model):**

```
P(capture) = a^γ / (a^γ + c·d^γ),   γ ≈ 3.3,  c ≈ 1.14
```

Cell-by-cell fit is near-exact: (3,2) 81%/77%, (4,2) 90%/90%, (3,1) 98%/97%, (5,3) 82%/83%,
(2,2) 47%/47%, (3,4) 26%/25%, (2,3) 16%/19%. The `c=1.14` handicap pulls equal fights to 47%
(attacker slightly disfavored) rather than a symmetric 50%.

### Theory
The outcome behaves like a **single decisive comparison weighted by ~the cube of strength**:
a 2:1 stack wins ~90%, 3:1 ~97%, equal ~47%. Note the *attritional* power-ratio fits poorly
(AIC 1347) — ±1-per-round can't be decisive enough; only applying the ratio **once** reaches
the observed sharpness. Whatever the app does internally (it shows a tick-down animation, so
it's likely fast attrition), its *capture probability* is that of a γ≈3 power-ratio duel.

### Identifiability caveat
Our data is **capture outcomes only**. We do **not** observe surviving strengths (attacker
remaining on a win, defender remaining on a repel), which the engine needs to continue the
game. Multiple mechanics fit the same capture curve while disagreeing on survivors — so the
capture *decision* is pinned down, the *post-battle stacks* are not.

### Candidate implementations
1. **Single-shot power-ratio decision + parametric survivor rule** (drop-in). Capture iff
   `rng() < aᵞ/(aᵞ+c·dᵞ)`; survivors from a guessed rule (calibrate later). Bonus: the
   engine's `capture_prob()` heuristic becomes a cheap closed form instead of a DP.
2. **Noisy strength comparison** (recommended — one mechanic yields *both*). Draw `Â=a·Xₐ`,
   `D̂=d·X_d` (i.i.d. positive noise, mean 1); capture iff `Â>D̂`; survivors `∝ |Â−D̂|`. A
   single noise-variance knob controls decisiveness (→ effective γ); survivors fall out for free.
3. **Risk-style multi-dice** (most "real-mobile-game"-like). Roll `min(cap,a)` vs `min(cap,d)`
   dice, compare sorted pairs, losers lose units, iterate. Ratio-dependent, bounded tails,
   natural survivors; fit the dice cap by simulation.

**Not viable:** keeping ±1 iterated attrition with a smarter per-round `p` — the fits show it
caps out (AIC 1347) well short of the single-shot fit.

### Shipped vs. proposed
- **Shipped:** `ATTACKER_WIN_P` 0.55→0.60 in `network_wars.py`, `fast_engine.c`, `game.js`
  (the MLE best *single value*; winrate-neutral in self-play because it's symmetric).
- **Proposed:** the power-ratio *shape* (γ≈3.3) — pending one capture-logging run to observe
  survivors and disambiguate models 2/3.

---

## 4. Theoretical effect on the MCTS

The C-UCT uses the engine for rollouts, in-tree move application, and the `capture_prob`
heuristic. The two corrections affect search differently.

**Deal fix — affects *evaluation* and *training*, not search per se.**
- Search starts from a given board, so balanced deals don't change a single decision. But our
  *measured* strength was wrong; the agent was always ~88–92%, just benchmarked on impossible
  boards. All historical offline winrates on i.i.d. deals understate strength by ~12–17 pts.
- For learned policies/values (PPO, value-leaf): training on i.i.d. deals wastes capacity on
  lopsided/unwinnable starts that never occur and biases toward desperation play. Retrain on
  the balanced distribution. Opening-value calibration should be redone.

**Battle-shape fix — the consequential one for search quality.** The current fixed-`p` model
*understates how decisive strength is*, which explains the two pathologies we observed:
- **Pessimistic winexp.** The engine thinks the agent's own favorable attacks fail too often
  (e.g. (3,2) modeled ~64% vs real ~81%), so rollouts undervalue aggressive expansion →
  systematically low win-probability estimates (we measured winexp badly miscalibrated; e.g.
  positions rated 15% actually won 72%). A γ≈3 model should largely fix this calibration,
  making winexp — and the dashboard readout — trustworthy.
- **Underestimating runaway bots.** Symmetrically, the engine underrates a *bot's* decisive
  attacks, so a snowballing bot (strong stack vs the agent's thin frontier) looks containable
  when it isn't. This is exactly the live loss pattern (bot reaches ~20 while winexp stays
  optimistic). Correct decisiveness → the search fears opponent snowballs at the right time —
  plausibly the "lose-less" lever prior offline sweeps failed to find *because they used the
  wrong battle model*.
- **Move selection should shift** toward concentrating force (high-strength stacks), attacking
  only with a clear ratio advantage, and avoiding coin-flip even fights — because under γ≈3
  margin/ratio is worth much more than the fixed-`p` model credits.
- **Asymmetric benefit to the adaptive player.** The constant→0.60 change was winrate-neutral
  (symmetric). But the *shape* change is not purely symmetric in effect: the bots play a fixed
  `best_bot_move` greedy policy (targeting independent of `p`), while the agent's search
  *adapts* to the true battle model. Correcting the shape lets the adaptive side exploit real
  decisiveness the bots can't → expected to *raise* winrate, not just recalibrate it.
- **Lower rollout variance.** A more decisive (less coin-floppy) battle model yields
  lower-variance leaf evaluations → more information per simulation → potentially equal
  strength at fewer sims, or higher strength at fixed sims.

---

## 5. Status

| Change | Where | State |
|---|---|---|
| Balanced 4-template deal (total 20/faction) | `network_wars.py`, `game.js` | ✅ shipped, verified |
| `ATTACKER_WIN_P` 0.55→0.60 | `network_wars.py`, `fast_engine.c`, `game.js` | ✅ shipped |
| Power-ratio battle shape (γ≈3.3) | — | 🔬 proposed (needs survivor data) |
| Docs (`CLAUDE.md`, `verify_port.py`, headers) | repo | ✅ updated |
| Parallel winrate harness | `par_eval.py` | ✅ added |

---

## 6. Next steps

1. ~~**Confirm the new offline winrate** on the iOS-faithful sim.~~ ✅ **Done: 91.5%
   (915/1000, 8000 sims)** — matches live 91.9%. Gap closed.
2. **Log battle survivors.** Run a capture-logging series (extend `iphone_data/capture_bots.py`)
   recording node strengths immediately before/after individual battles. This is the missing
   data to disambiguate the survivor rule and fit models 2/3.
3. **Implement the power-ratio battle** (model 1 first: closed-form `capture_prob`, then a
   survivor rule from step 2) in `network_wars.py` + `fast_engine.c` + `game.js`; keep the three
   in sync.
4. **Re-baseline + re-tune** the C-UCT on the corrected engine: re-run the AlphaGo-style lever
   sweep (priors, value-leaf, LCB, behind-safety) — they may behave differently now that the
   underlying value is correctly calibrated. Re-check winexp calibration against live games.
5. **Re-validate on the phone.** Run a fresh live series and confirm offline and live winrates
   now agree (the real test that the calibration is faithful).
6. **Retrain learned policies** (if pursuing the PPO/value path) on the balanced deal +
   corrected battle distribution.
