# The iOS Network Wars battle function — data, fit, confidence, open questions

_Updated 2026-06-22. Supersedes the battle section of `IOS_CALIBRATION.md`._

## TL;DR

From **3,308 ground-truth live battles** we replaced the engine's iterated-Bernoulli-at-0.60
battle with a **power-ratio** mechanic that fits both *who wins* and *how many troops survive*:

- **Who wins (per round):** attacker wins with probability `a^k / (a^k + c0·d^k)`, `k≈0.62`,
  `c0≈0.9` — steeper and more decisive than a fixed coin. (As a single-shot outcome model,
  `P(capture) = a^γ/(a^γ + c·d^γ)` with **γ≈3.37, c≈1.30** is the best pure-outcome fit.)
- **Capture:** requires the attacker to still have ≥2 when the defender reaches 0 (one to
  occupy, one garrison). Captured node gets `a_remaining − 1`; source keeps 1.
- **Repel:** source → 1; defender remnant → `max(0, d0 − a0 + 1)` (gutted by the full
  attacking force).

Confidence: **high** on the capture-probability shape and the survivor rules. The mechanic is
deployed live (`fast_engine_pr.c`). Reference implementation + self-test: `iphone_data/battle_model.py`.

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

- `iphone_data/battle_model.py` — reference mechanic + drop-in `resolve_battle` + self-test.
- `iphone_data/extract_battles.py` — pull `(a,d,outcome,survivors)` from any series/botcap log.
- `iphone_data/fit_battle.py` — outcome-model MLE/AIC + calibration + survivor lstsq.
- `iphone_data/fit_mechanic.py` — joint outcome+survivor generative fit.
- `fast_engine_pr.c` / `fast_engine_pr.so` — the deployed power-ratio C search engine
  (select at runtime via `NW_ENGINE_SO`).
- `eval_corrected_env.py`, `eval_search_engine.py` — offline A/Bs that showed the corrected
  battle is winrate-positive for red (90%→96% env; 95.7%→98.0% search, same seeds).
