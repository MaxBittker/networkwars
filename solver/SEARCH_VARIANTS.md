# Search variants study (lab log) — 2026-07-01

Question: can we raise C-UCT win-rate at ~equal wallclock? Three structural,
wallclock-neutral levers were implemented in `fast_engine.c` (all opt-in,
default OFF; gates + golden seeds bit-identical when off) and benchmarked
paired-seed vs baseline with `bench_ab.py` (per-seed JSONL, McNemar z on
discordant pairs).

**Code status after the study: chance-split is now THE search** — adopted
unconditionally on 2026-07-02 (toggle removed; native + WASM rebuilt, all
gates pass — the golden games use scripted policies, not the search, so no
re-freeze was needed). The two losing levers below were REMOVED from the
code — this log is their record; reimplement from the descriptions here if a
retest is ever warranted.

## Levers

1. **Chance-split** (ADOPTED, unconditional): the open-loop tree funnels capture AND
   repel outcomes of an attack edge into ONE child node, so the follow-up plan
   is averaged over incompatible worlds (RED chains ~6.3 attacks/turn → 2^6
   outcome combos collapsed). The lever keys each attack edge's child on the
   sampled outcome (capture → `E_CHILD`, repel → `E_CHILD2`). Edge stats
   (PUCT Q) stay action-level; only the subtree becomes outcome-coherent.
   Per-sim cost unchanged.

2. **C1 heuristic priors** (REMOVED — was `uct_set_priors(temp, eps)`): at
   expansion, set child priors to softmax(ranked_score/T) + eps-uniform floor
   instead of uniform, END scored at RW.threshold. ~20 lines in the expansion
   block. NOTE for any retest: concentrated priors inflate the PUCT U-term of
   high-prior moves, so c_puct must be re-tuned downward alongside (2.5 is
   tuned for uniform 1/nc).

3. **Within-turn tree reuse** (REMOVED — was `uct_advance(act, owner_now)` +
   an ADOPTED branch in `uct_setup` that kept pools and re-rooted at the
   chosen edge's outcome-keyed child): after the REAL battle resolved, adopt
   the subtree as the next search's root and spend the full budget on fresh
   sims. Adoption rate was 98%, but carried only median ~240 / mean ~430
   visits into a 2000-sim search (the subtree's visits are split across
   outcomes and its own children).

## Results (seeds paired across arms, 2000 sims, c_puct 2.5, nroll 1)

| arm | n | winrate | vs base discordant | z |
|---|---|---|---|---|
| base | 1800 | 91.94% | — | — |
| **chance-split** | 1800 | **92.39%** | +94/−86 | **+0.60 (ns)** |
| chance-split + reuse | 600 | 92.2% | +31/−33 | −0.25 (ns) |
| reuse only | 600 | **80.3%** | +23/−96 | **−6.69** |
| priors t=60 c=0.8 | 120 | 90.8% | (probe; base same seeds 95.8%) | — |
| priors t=60 c=2.5 | 120 | 90.0% | | — |
| priors t=120 c=1.5 | 120 | 92.5% | | — |

8000-sim (live-config) confirmation, 600 paired seeds:

| arm | winrate | vs base discordant | z |
|---|---|---|---|
| base @8k | 95.3% | — | — |
| chance-split @8k | 95.7% | +20/−18 | +0.32 (ns) |

(Per-sim cost is unchanged — one descent + one expansion + one rollout either
way; wallclock differences between runs in the logs are machine contention,
same-batch probes measured ~equal ms/game.)

## Conclusions

- **Reuse without outcome-keying is catastrophic (−12pt)**: the adopted child's
  stats mix capture+repel worlds that no longer match the realized board; the
  biased warm start survives 2000 fresh sims. Strong direct evidence that
  outcome-incoherence in the open-loop tree is a real error source.
- **Reuse even WITH outcome-keying adds nothing** (−1.6pt vs csplit alone,
  z=−1.44): carried visits are still conditioned on the parent's open-loop
  board distribution (survivor counts etc.), and extra effective sims are
  worth ~nothing here (consistent with the flat sims-scaling finding).
  Do not warm-start; cold trees are unbiased.
- **Heuristic C1 priors hurt at every temp/c_puct tried** (~−3 to −6pt probes):
  C1 is a weak player (52% greedy), so concentrating exploration on its
  preferences misguides the search. Confirms the old "priors ruled out" result
  post-recalibration.
- **Chance-split is the one keeper**: theoretically correct, zero wallclock
  cost, and non-negative in all three measurements (+1.3pt n=600, 0.0pt
  n=1200, +0.4pt n=600@8k; pooled ≈ +0.4pt, z≈0.6 — not significant). Made
  the unconditional default 2026-07-02 (one less parameter); do not expect a
  measurable live gain. Consistent with every prior study: remaining losses
  are deal+dice-bound, so search improvements have ≲1pt of headroom at this
  operating point.

## Ideas researched but NOT tested (and why)

- Root/leaf parallelization: changes the wallclock budget rather than using it
  better; WASM threading story is poor; flat sims-scaling caps the upside.
- Value-leaf truncation → more sims/sec: already settled (speed win, strength
  tie; extra sims don't convert — see fitted-value-leaf + scaling memories).
- Closed-loop chance nodes over END (bot turns): chance space far too large.
- MCTS-Solver proven-value backup: rollouts are already exact at decided
  extremes, negligible expected effect.
- FPU tuning / robust final selection: micro-levers dominated by the above nulls.

Tooling: `bench_ab.py` (paired-seed arms + `--compare` McNemar; the variant
CLI flags were removed with the code once chance-split became the default).
The per-seed `bench_*.jsonl` result files were deleted after the study; the
tables above are the record. Benchmark recipe: 2000 sims (92% baseline) is the
sensitive operating point, confirm at 8000; n=600 resolves only ≥2pt effects,
n=1800 ≈1pt.
