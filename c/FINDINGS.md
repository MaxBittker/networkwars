# Pushing past ~80%: AlphaGo-style experiments (overnight 2026-06-20)

Goal: beat the pure C-UCT player's ~79–80% seed-free win rate using AlphaGo/AlphaZero
ideas. Baseline (this run, dev seeds 1..500, b4000, cpuct2.5/fpu0.5/selmean/minvis80):
**79.0% (395/500)** — reproduces the report's 79.2%. Noise on 500 games ≈ ±1.8pp (1σ).
Dev=1..500, held-out=2001..2500, distill/train seeds=3001..3400 (all disjoint).

## TL;DR
Every cheap model-based AlphaGo lever was tested *fairly* and **none beat the
baseline**. The pure rollout-to-terminal C-UCT is at/near its structural ceiling;
the binary Monte-Carlo terminal signal is the right tool for this dice-only
problem, and no prior or value (hand *or* trained) improves on it. One practical
win emerged: a learned-value truncated leaf matches strength at ~2× speed.

## Experiments

### A. AlphaGo value mixing: leaf = (1-λ)·rollout + λ·value   — FAILS
- λ=0.1 @ b4000 = 74.2% (−4.8pp).
- **Found a bug:** the default `--evref/--evscale` (1600/650) are wildly wrong for
  the 7×6 rules. evalpos actually ranges [−23238, 6954] (mean −2522), so the
  default logistic gave BCE **5.12** (confidently wrong). This retroactively
  explains the original report's "leafeval/evalpos-prior hurt": those levers were
  always run with a broken value scale.
- Re-tested with a *calibrated* evalpos (ref=−5027, scale=4797, BCE 0.567):
  vmix=0.15 = 75.2% (−3.8pp). Calibration helped ~1pp but still hurts — because
  evalpos (BCE 0.567) barely beats the base rate (0.46), i.e. it is mostly noise,
  and mixing noise into the well-averaged rollout degrades selection.

### C. Distilled linear policy prior (teacher = the 80% search) — NEUTRAL/weak
- Fit a linear policy to the search's root visit distribution. Loss plateaued at
  2.03 vs uniform 2.20 (only 0.17 nats): visit counts under a uniform-prior UCT
  are a weak teacher (early visits spread by exploration, not move quality).
- Consistent with the report: hand priors hurt; a faithful distill is at best
  neutral. (Net priors are also weaker here — report's net-MCTS = 57% << 79%.)

### D2. Richer learned VALUE (8 features → search win-prob) — good value, still no win
- 8-feature logistic value (largest-comp, red strength, enemy-leader strength,
  fragmentation, bot-threat…), close-game-weighted, fit to the search's own
  win-probabilities: **BCE 0.251 vs base rate 0.477** — the first value that
  clearly beats the base rate (vs evalpos's useless 0.567).
- Yet vmix=0.15 with it = 77.8% (−1.2pp, within noise). A *good* value only
  *matches* the rollout signal; it cannot beat it. This is the crux result.

### E. LCB root selection (mean − β·stderr) — FAILS
- β=0.5/1.0/2.0 → 77.6/77.0/76.0 (monotonic hurt). For a binary win/loss the mean
  *is* the right objective; `minvis` already guards lucky low-visit picks, so the
  LCB only adds harmful conservative bias. ⇒ selection variance is not the limiter.

### Re-tune (b4000, 500g) — every knob already optimal
- cpuct 2.0/2.5/3.0 → 78.4/79.0/76.6;  fpu 0.3/0.5 → 75.4/79.0.
- minvis 40/60/80/120/160 → 78.2/77.4/**79.0**/75.2/77.6 (80 is best — was never
  grid-searched before tonight; now confirmed). Rollout-weight perturbations
  (grow/lead/floor) were also null, as the report predicted.

### Practical win: truncated-rollout value leaf — ~same strength, ~2× faster
- `--rollh 2` + learned value leaf @ b4000: dev 77.4% @ 395 ms/game, **held-out
  (2001..2500) 80.0% @ 420 ms/game** — vs baseline dev 79.0 @ 783 ms / held-out
  **80.8 @ 825 ms**. Combined 1000g: value-leaf 78.7% vs baseline 79.9% (~1pp
  weaker, ~2σ boundary) at **half the compute** → a real latency win for the live
  iOS player (report §5.7), at most ~1pp strength cost.
- Same-wall-clock variant (value-leaf @ b8000 = 78.6% dev) matches baseline: the
  budget curve stays flat even with the lower-variance leaf — extra sims still
  don't help. rollh=3 @ b4000 = 77.2% (no recovery of the small gap).

### Baseline strength (best estimate)
Combined dev(1..500)+held-out(2001..2500) = **79.9% over 1000 games** — the player
is a genuine ~80%. Held-out 80.8% > dev 79.0% (this seed range is slightly easier;
earlier report held-out 1001..1500 was 77.4%). All seed-free, no RNG exploitation.

### G. Board-level CNN policy as a root prior (the real net attempt) — NEUTRAL
- Hand-feature priors are FEATURE-limited: an MLP on the 9 action-features caps at
  top1 0.27 (≤ capprob-greedy 0.29). Going spatial fixes it — a CNN over the 7×6
  board (rl/ 28-channel obs) predicts the C-UCT's exact move at **top1 0.49,
  top3 0.72** (8.7k-decision val). So a sharp, learnable, board-aware prior exists.
- Wired into fastnw uct_search's `root_pri` hook (non-destructive, no committed
  code touched). fastnw seeds 1..200 @ 2000 sims: baseline 74.5% vs CNN-root-prior
  **73.5%** (−1pp, within noise). A *good* prior still doesn't help.
- Caveat: root_pri is ROOT-ONLY (the only non-destructive hook); at 4000 root sims
  every move is already explored, so this is a conservative test. A full per-node
  AlphaZero prior would need the CNN ported into C (~multi-day) — untested. But
  given every other negative, the odds it helps are low.
- Positive byproduct: the board-CNN is a strong standalone policy (top1 0.49) —
  reusable for a fast policy player or the iOS app. Code: rl/exp_netprior_gate.py,
  rl/integrate_netprior.py.

## Conclusion
The ~79–80% wall is **structural, not a model-quality problem** — now shown with
fair tests rather than assumed, including a genuinely sharp learned CNN prior. To cross it you must change *what the search
computes* (closed-loop chance nodes, §5.4 — the one untested lever with real
upside, deferred here as a high-risk rewrite that needs careful verification) or
accept that much of the remaining gap to the dice-known oracle (~92%) is
irreducible variance a fair player cannot recover. The cheap levers are exhausted.

The experiment hooks live in `c/nw.c` behind CLI flags (all default-off, baseline
preserved): `--vmix` (value mixing, Exp A), `--lprior` + `--dumpfeat` (distilled
linear prior, Exp C), `--vvalue` + `--dumpval`/`--dumpvf` (learned value, Exp D2),
`--lcb` (LCB root selection, Exp E), `--r2pen` (2-stack capture penalty). The
board-CNN prior gate (Exp G) is `rl/exp_netprior_gate.py` +
`rl/integrate_netprior.py`. The overnight scratch (raw feature dumps, run logs,
fit scripts) was discarded after distilling the conclusions above.
