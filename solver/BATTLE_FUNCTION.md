# The iOS Network Wars battle function — data, fit, confidence, open questions

_Updated 2026-06-22. Supersedes the battle section of `IOS_CALIBRATION.md`._

## TL;DR

> **SHIPPED MODEL: single-shot power-ratio (§6, 2026-06-23) + fitted (a,d)
> survivor planes (§7, 2026-06-24).** Read §6 for the win/loss draw and §7 for the
> troops-remaining outcome — together they are what `fast_engine.c` does today. The
> history below documents the earlier *iterated* mechanic (k=0.62) and the old
> `max(1,a−d)`/`max(0,d−a+1)` survivor clamp that §7 replaced.

From **3,308 ground-truth live battles** we replaced the engine's iterated-Bernoulli-at-0.60
battle with a **power-ratio** mechanic that fits both *who wins* and *how many troops survive*:

- **Who wins:** the best, simplest fit is a single-shot `P(capture) = a^γ/(a^γ + c·d^γ)`
  with **γ≈3.40, c≈1.26** (§6, re-fit on 7,222 battles — this is what ships). The earlier
  per-round form `a^k/(a^k + c0·d^k)`, `k≈0.62` is steeper than a fixed coin but too soft at
  the contested margins; §6 supersedes it.
- **Capture:** occupier = `max(1, a − d)`; source keeps 1.
- **Repel:** source → 1; defender remnant → `max(0, d0 − a0 + 1)` (gutted by the full
  attacking force).

Confidence: **high** on the capture-probability shape and the survivor rules. Shipped in
`fast_engine.c`; fit/comparison tooling: `iphone_data/refit_battle.py`, `refit_emergent.py`.

---

## 1. The data

How it was collected: `series.py` was instrumented to log the full board (with per-node
strengths) **after every red attack**. In the iOS app one red tap resolves exactly one battle,
so chaining `board_before → board_after` yields a clean single-battle observation
`(a, d, outcome, survivors)`. `iphone_data/extract_battles.py` extracts them; `fit_battle.py`
and `fit_mechanic.py` fit models. Source: red's own attacks across the live series runs
(`series_20260621_battle.jsonl`, `series_20260622_prsearch.jsonl`) plus the earlier
`runs/botcap.jsonl`.

**N = 3,308 battles** (≈2,100 captures, ≈1,080 repels).

### What the raw data shows

Capture rate is a smooth, steep function of the strength **ratio** (margin shown for legibility):

| a − d | n | observed capture % | shipped Bernoulli p=0.60 predicts |
|------:|----:|:--:|:--:|
| ≤ −3 | 75 | 6.7% | 13.8% |
| −2 | 126 | 11.1% | 21.2% |
| −1 | 379 | 17.4% | 29.3% |
| 0 | 615 | 43.6% | 45.0% |
| +1 | 645 | 75.3% | 65.2% |
| +2 | 447 | 88.6% | 82.9% |
| +3 | 292 | 94.2% | 91.7% |
| ≥ +4 | 608 | 97.9% | 97.7% |

The shipped model is **systematically too soft**: it gives the underdog far too much hope
(predicts 29% at −1 where reality is 17%, 21% at −2 where reality is 11%) and under-credits the
slight favorite (predicts 65% at +1 where reality is 75%). Reality is **steeper / more decisive**.

### Survivors

- **Source node:** keeps exactly **1** in ~99-100% of all battles (win or lose).
- **Capture:** captured node ends at ≈ `a − d` with attrition spread (the attacker loses
  ≈ one troop per defender killed; mean observed remnant 2.98).
- **Repel:** defender is **gutted to ~1.5 on average**, far below what symmetric attrition
  predicts — the attacker's whole dying force subtracts.

---

## 2. The fitted function

### Model comparison (MLE / AIC on outcomes, n=3,187)

| model | params | AIC | |
|---|---|---:|---|
| **power-ratio** `a^γ/(a^γ+c·d^γ)` | γ=3.37, c=1.30 | **2591.6** | ← best |
| logistic (margin) | k=1.05 | 2647.3 | |
| Bernoulli ruin (shipped) | p=0.596 | 2711.4 | |
| near-deterministic | eps=0.13, tie=0.44 | 2798.1 | worst |

Power-ratio wins decisively (ΔAIC ≈ 120 over the shipped Bernoulli).

### The generative mechanic (what's deployed)

A single iterated process reproduces both outcomes and survivors:

```
state (a, d):  while a > 1 and d > 0:
    attacker wins w.p.  q = a^k / (a^k + c0·d^k)   ->  d -= 1
    else                                            ->  a -= 1
CAPTURE iff d == 0 and a >= 2:   node = a-1,  source = 1
REPEL   otherwise:               source = 1,  node = max(0, d0 - a0 + 1)
```

Fitted: **k ≈ 0.62, c0 ≈ 0.9** (joint outcome+survivor fit). Self-validation of this exact
mechanic against all 3,187 battles:

| check | observed | model | MAE |
|---|---|---|---|
| overall capture rate | 66.0% | 62.6% | — |
| capture-node remnant (n=2,104) | 2.98 | 3.13 | **0.77** |
| repel defender remnant (n=1,079) | 1.48 | 1.51 | **0.81** |

### Three concrete differences from the shipped engine

1. **Per-round odds are strength-proportional**, not a fixed 0.60 → the decisive steepness.
2. **Capture needs a surviving occupier** (a≥2 when d hits 0). The shipped engine flips
   ownership even when the attacker is spent (node ends at 0); iOS does **not** — that node
   stays enemy-owned at 0. Confirmed by `def_survivor=0` repels and the absence of strength-0
   captures.
3. **Repel guts the defender** by the full attacking force, not soft attrition.

---

## 3. Confidence

**High confidence:**
- The capture curve is steeper than constant-p, monotone in ratio, and power-ratio-shaped.
  3,308 battles, AIC gap ≈120, and the shape is stable: γ has held ≈3.1–3.4 across the whole
  collection; the generative `k` ≈0.62–0.75 (the difference is immaterial — capture
  probabilities differ ≤2.1 pts between k=0.62 and k=0.75).
- Source-keeps-1 (~100%) and the capture/repel survivor rules (MAE ≈0.8, ~0.8 strength on a
  0–8 scale — i.e. within OCR noise).
- The "no-occupier-no-capture" rule (difference #2) — directly observed.

**Medium confidence:**
- The exact `k`/`c0` and whether the per-round law is precisely `a^k:d^k` vs another steepening
  function. The single-shot power-ratio (γ≈3.37) fits outcomes slightly better than the
  deployed generative k=0.62 — which **under-predicts the +1 margin** (model 64% vs observed
  75%). The true per-round steepness is likely a touch higher than k=0.62.

**Low confidence / unmodeled:**
- Behavior at extreme strengths (a or d ≳ 12) is sparsely sampled.
- Whether survivor spread is "real" stochastic attrition vs ±1 OCR jitter — we can't fully
  separate them, but it doesn't change move quality.

---

## 4. Open questions

1. **The +1 steepness gap.** The deployed k=0.62 generative model under-predicts captures at
   margin +1 (64% vs 75% observed). A higher per-round k (≈0.75) or a different steepening
   function would fit the outcome curve better while keeping survivors. Worth a joint refit that
   weights the contested region, then a small offline A/B — but the live effect is likely tiny
   (capture curves differ ≤2 pts).
2. **The big one — why is live winrate ~77% when offline-corrected self-play is ~96%?** This is
   NOT the battle model (now accurate), NOT the deal (balanced/correct), and NOT execution
   (~1% tap misses, no parse failures). The leading hypothesis is that the **real iOS bots are
   stronger than our `best_bot_move` model** beyond targeting (e.g. reinforcement, or
   coordination) — offline, red faces our weaker bot model and over-performs. Secondary
   suspects: silent OCR strength-misreads that produce legal-but-suboptimal live moves. This
   gap, not the battle function, is now the main lever for understanding true strength.
3. **Survivor stochasticity.** Is the capture-remnant spread a real attrition distribution or
   OCR noise? Distinguishing them needs repeated identical (a,d) matchups, which red rarely
   produces.

---

## 5. Artifacts

- `iphone_data/extract_battles.py` — pull `(a,d,outcome,survivors)` from any series/botcap log.
- `iphone_data/refit_battle.py` — logistic-MLE (IRLS, no scipy) model comparison + calibration.
- `iphone_data/refit_emergent.py` — iterated-DP vs single-shot MLE fit (the §6 comparison).
- `fast_engine.c` — the single shipped engine; battle lives in `pr_cap` + `resolve_battle`.
  (Older `battle_model.py`, `fit_battle.py`, `fit_mechanic.py` documented the superseded
  iterated mechanic; see git history.)

---

## 6. 2026-06-23 re-fit (now 7,222 red-attacker battles)

Re-ran the fit on the full accumulated logs (`extract_battles.py runs/*.jsonl` →
7,222 valid red battles, 66.1% capture; tooling: `iphone_data/refit_battle.py`,
`iphone_data/refit_emergent.py`). "Simplest model that best explains it",
MLE on the compressed (a,d) table:

| model (2 params) | logLik | AIC |
|---|---:|---:|
| SHIPPED iterated `q=a^0.62/(a^0.62+0.93 d^0.62)` | −3036.7 | 6077.4 |
| REFIT iterated `k=0.869, c0=0.885` | −3004.6 | 6013.2 |
| **REFIT single-shot `P=a^3.40/(a^3.40+1.26 d^3.40)`** | **−2968.5** | **5941.0** |

The **single-shot power-ratio is both the simplest algorithm (one closed-form
Bernoulli, no iteration loop) and the best fit.** The deployed iterated k=0.62 is
systematically too soft in the contested region that decides games — margin 0:
38.6% vs **44.5% observed**; margin +1: 64.3% vs **74.2% observed**. Single-shot
nails both (44.3% / 76.0%). γ≈3.40 is stable vs the 2026-06-22 fit (3.37) on 2× data.

Survivors stay deterministic and within OCR noise of the data:
- capture occupier = `max(1, a−d)` (obs mean 2.86, MAE 0.68)
- repel defender remnant = `max(0, d−a+1)` (obs mean 1.45, MAE 0.81)

Implemented in `fast_engine_battle.c` (single draw + deterministic survivors;
`build_cap_tables`/`capture_prob`/`exp_cap_strength` filled from the closed form
to stay consistent with `resolve_battle`). **Offline A/B (800 games, 8000 sims,
same seeds): 97.0% → 98.8% (+1.8 pts).** Direction matches the 2026-06 recal
(steeper, more-decisive battles favor the stronger MCTS player by cutting
variance) — but recall the live A/B for that change was NULL (~80% plateau), so
treat the offline gain as variance-reduction, not necessarily a live lever.

NOT YET DONE: shipping it (would re-freeze `validate_fast.py` golden seeds) and a
live A/B. Build: `cc -O3 -ffast-math -shared -fPIC fast_engine_battle.c -o
fast_engine_battle.so`, select via `NW_ENGINE_SO=./fast_engine_battle.so`.

---

## 7. survivor re-fit (SHIPPED) — (a,d) occupier plane + defender-remnant hinge replace the margin clamp

The §6 win/loss draw is excellent, but the **survivor** rules (`max(1,a−d)`,
`max(0,d−a+1)`) were a clipped-margin simplification that misfit the data. The key
finding: **survivors depend on absolute size, not just margin** — at margin +1 the
occupier rises 1.0→2.0 from 2v1 to 5v4; at margin 0 the repel remnant rises
0.83→1.71 with size. A margin-only clamp structurally cannot capture that.

Re-fit on **9,445 live battles** (`extract_battles.py runs/*.jsonl`,
`plot_battle_compare.py`) with weighted least-squares **planes in (a,d)**, clipped
to the feasible range:

- capture occupier  = `clip(0.82·a − 0.44·d + 0.10,  1,  a)`        (plane)
- repel  remnant    = `clip(0.30 + 0.24·d + 0.42·max(0, d−a),  0,  d)`  (HINGE — see below)

**Mean-fit RMSE per (a,d) cell** (the curve's job — predict the conditional mean):

| survivor | old clamp | shipped curve | 5-fold CV |
|---|---:|---:|---:|
| capture occupier (plane) | 0.49 | **0.29** | 0.34 |
| repel defender remnant (hinge) | 0.59 | **0.11** | 0.14 |

(Per-battle RMSE only drops modestly — ~1 troop of within-cell spread is
irreducible, OCR jitter + real attrition variance the deterministic curve can't
remove. The mean is what improved.) A generative war-of-attrition model was tried
and is **worse** (occ RMSE 0.76) — too much spread.

**Remnant: the HINGE beats the plane (2026-06-25).** The linear remnant plane
under-fit *both* tails — it under-credited big-deficit repels (a much-stronger
defender keeps more, approaching `d−a+1`) and zeroed out the **lucky-repel floor**
at margins +2/+3 (a stronger attacker that somehow gets repelled still leaves the
defender ~1). `max(0, d−a)` only fires when the defender is bigger (softer-than-1:1
gutting), and `0.30 + 0.24·d` is a size-scaled floor. RMSE 0.18 → **0.11** (CV
0.14); the worst per-margin miss (+3: −0.63 troops) drops to −0.02. The marginally
better harmonic form `a·d/(a+d)` (RMSE 0.097) was **rejected** — its division
reintroduces the x.5 cross-arch rounding hazard; the hinge is integer-clean and the
most accurate *plausibly-shippable* curve. Occupier stays the plane (no clearly
better plausible form found).

**Shipped in `fast_engine.c`** (`fit_occ`/`fit_defrem`, used by `resolve_battle`,
`resolve_battle_logged`, and the `CAPES` policy table). Coefficients are scaled
×100 and evaluated in **pure-integer arithmetic** (`iround100`): a float form lands
exactly on x.5 boundaries (e.g. occ(6,8)=1.50) where `-ffast-math` native and
no-`-ffast-math` WASM round differently — integer math is bit-identical across
both. Gates re-frozen: `validate_fast.py` golden seeds + battle invariants,
`wasm_gate.mjs` battle invariants. Both pass (board-gen still 1000/1000
bit-identical). Source always → 1 (~100%) is unchanged. **Offline winrate
(8000 sims):** planes 96.5% (n=1000) → hinge 96.2% (n=500) — statistically
indistinguishable. The hinge is a better *data fit*, not a winrate lever: survivor
accuracy is variance-reduction, the MCTS player already wins the games the survivor
detail would swing. Ship for fidelity to the real game, not for score.
