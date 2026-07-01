# The iterated battle model — study & result

_Companion to `BATTLE_FUNCTION.md`. Implementation: `iterated_battle.py`.
Figures: `iphone_data/make_battle_pdf.py` → `battle_model_comparison.pdf`._

## Question

The shipped engine resolves a battle with a **closed form** — one Bernoulli for the
outcome (`P=a^3.40/(a^3.40+1.26 d^3.40)`) plus two separately-fitted survivor
distributions. That fits well but is a *statistician's* model, not how a game is
built. Could the same 12,670 live battles come from a **single iterated play-out** —
the kind of loop a developer would actually write — and how well does it fit?

We score every candidate by the **full joint likelihood**: the outcome Bernoulli
plus the actual likelihood of every observed survivor count under the model's
emergent distribution (so spread counts, no arbitrary weights), against the
empirical noise floor (the best any model could do in-sample).

## Result — the iterated battle function

```python
def battle(a, d, rand):                        # a attacks d
    while a > 1 and d > 0:
        if rand() < 0.50: d -= 1               # attacker volley lands (lethal)
        if rand() < 0.28: a -= 1               # defender volley lands
        elif rand() < 0.05*d**0.53/(d**0.53 + 4.98*a**0.53):
            break                              # attacker routs -> repel
    if d == 0:                                 # CAPTURE (source keeps 1)
        return 'capture', a - 1
    mu = max(0.0, 0.30 + 0.24*d + 0.42*max(0, d - a))    # remnant hinge (decoupled)
    return 'repel', sum(rand() < mu/d for _ in range(d))
```

A **lethal attacker** trades volleys; its win is **decoupled from depletion by a
ratio-sensitive rout**, so a still-lethal attacker can be repelled *after* gutting
the defender. The occupier falls out of the play-out; the remnant is a decoupled
hinge draw (see below).

| model | joint NLL | excess over floor (16,792) |
|---|---:|---:|
| shipped closed form | 19,134 | +2,342 |
| pure iterated loop | 18,780 | +1,987 |
| **hybrid (loop + hinge remnant)** | **18,321** | **+1,529 ← best** |

On the full joint likelihood the hybrid **edges the shipped closed form** — see
"why" below.

## Three things worth keeping

**1. The obvious loop is already close.** Plain single-casualty attrition
`while a>1 and d>0: d-=1 if rand()<a/(a+d) else a-=1` (0–1 params — Lanchester's
1916 square law) fits the *outcome* curve to ≈ΔAIC 140 of the closed form. Its only
real miss is the **+1 margin** (~70% vs the observed ~75%): that sharpness is a
property of resolving the fight in *one shot*, which no attrition loop reproduces.

**2. One homogeneous loop can't fit outcome and survivors together.** Real repels
are **bloody** (the defender is gutted — a high-lethality signature) yet the outcome
still has **upsets** (~10% repels even at margin +2 — a low-lethality signature). A
single per-round rule on state `(a,d)` has one lethality, so it must choose. The
rout is what lets the lethal-attacker loop have both a gutted defender *and*
high-margin upsets — the best a pure play-out manages.

**3. The remnant must be decoupled.** The play-out genuinely *cannot* produce the
repel remnant: a depletion-repel is by definition the case where the attacker got
unlucky and killed few defenders (conditioning), and the real loss scales with the
defender's size `d`, not the attacking force. So the remnant is drawn from the
documented "assault guts the defender" hinge instead of read off the play-out —
dropping its RMSE 0.34 → 0.10 and making the hybrid the best-fitting model overall.

**Why the hybrid beats the closed form:** it pairs the loop's *better occupier* with
the hinge remnant. The shipped beta-binomial occupier **collapses onto its ceiling**
in high-margin small-army cells (e.g. `a=4,d=1` assigns ~0 probability to occupier
values that actually occur) — a real weakness of the production model that the
play-out's smoother occupier avoids.

## Status & reproduction

Study artifact — **the production engine keeps the closed form** (`fast_engine.c`,
`BATTLE_FUNCTION.md`); nothing here changes gameplay.

```
python iphone_data/extract_battles.py runs/*.jsonl > /tmp/all_battles.csv
python iterated_battle.py /tmp/all_battles.csv          # reprints the comparison table
python iphone_data/make_battle_pdf.py /tmp/all_battles.csv   # regenerates the figures PDF
```
