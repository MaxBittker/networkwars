# Search and projection math audit — 2026-09-07

The search is single-agent stochastic PUCT: RED chooses attacks or END, the
four deterministic bots are folded into END, and private simulation dice supply
chance. All backed-up rewards are from RED's perspective, so there is no
alternating-player sign flip. The basic backup is correct:

`Q(action) = sum(RED terminal-win rewards) / visits(action)`

With multiple rollouts per leaf, one visit backs up their average. These are
adaptive search estimates under the rollout/search policy, not independently
calibrated probabilities or confidence bounds. In particular, a reported 100%
does not establish a guaranteed win.

## Corrections

- **Sampled legality.** Attack capture/repel splitting does not fix the sampled
  survivor strength or the outcomes of subsequent bot turns. A node's original
  actions can become illegal, and new legal attacks can appear. The original
  engine executed 8,180 illegal sampled attacks across 40 opening searches of
  1,500 simulations (seeds 1–40, sim seed 123). Nodes now retain the union of
  observed legal actions and select only actions legal on the current sample.
  Edge blocks grow without discarding existing visits, rewards, or children.
  Uniform exploration weight uses the number of currently legal actions.
- **Chance terminals.** A terminal outcome of one simulated END was cached in
  its shared child and reused on later nonterminal outcomes. Terminal rewards
  are now backed up only for the sampled outcome; only an already-terminal
  root is cached. Terminal roots expose no playable actions.
- **Horizon consistency.** Rollouts used to award a win for a strict plurality
  at the turn limit, while tree search counted an unfinished game as a loss.
  Both now require an actual RED victory. An 18-to-12 disconnected stalemate
  reproduces the old phantom win. This is conservative truncation, not a new
  live-game victory rule.
- **Large-stack battle estimates.** Independently clamping both strengths to
  159 made 400 versus 160 read as 49.2083% capture. The ordinary lookup table is
  unchanged; overflow pairs now use the same exact dynamic program with two
  rows and a bounded result cache. Probability is effectively 100% in that
  example. Survivor estimates also retain actual stack sizes. If the temporary
  DP allocation fails, the former bounded approximation is retained as fallback.
  A one-army source correctly has zero capture probability even against zero.
- **Grading.** A winning recommended move does not imply every alternative
  wins. Grading no longer stops because the leader crosses a value threshold;
  choices use the full 24,000-simulation budget, while a forced move can stop
  at the 16,000 floor. A decision is excluded as low-signal only when both the
  recommended and played values lie in the same extreme band (≤2% or ≥98%).
  For example, 99.5% versus 30% is retained as a 69.5-point blunder.
- **Projection alignment.** Win curves use the first decision of each turn.
  Missing first-decision reviews remain holes rather than borrowing a later
  post-battle value and plotting it at turn start. Lines break at missing values.
- **Search accounting and lifecycle.** Root expansion consumes a simulation
  without visiting an outgoing edge. Driver totals now use the actual completed
  simulation count. An early-stopped streaming search stays stopped. A zero
  rollout count is normalized to one rather than producing NaN. The JS streaming
  wrapper reports allocation failure instead of continuing with an old search.
- **Saved reviews.** Review version 2 invalidates earlier evaluations when replay
  actions remain, allowing background rescoring. Trimmed historical scores are
  retained but marked stale and excluded from current skill comparisons.

## Math that was checked and retained

For the main battle loop, conditioning away the 25% no-hit round gives

`P(a,d) = [P(a−1,d−1) + P(a,d−1) + P(a−1,d)] / 3`.

The successful-occupier first moment obeys the same recurrence, with boundary
`S(a,0)=a−1` for `a>1`. Folding in the two guarded pre-fires and dividing the
unconditional moment by capture probability gives the conditional survivor
expectation. A 2-versus-1 attack captures with probability 5/6. The simultaneous
last-unit loss remains a repel, consistent with the actual battle routine.

The strict visit-margin stop is valid: if `leaderVisits − runnerUpVisits` is
greater than the number of simulations remaining, the chosen visit leader
cannot change within that budget. This locks the move, not its Q estimate.
Value/deep-think stops used in play remain heuristics, not statistical proofs.
The sweep certificate evaluates the actual sweep policy on fresh dice, which
is the right quantity; it is still a sampled assurance, not a guarantee.

Review comparisons retain the visit-selected recommendation rather than taking
the maximum of many noisy Q estimates. The nonnegative loss is measured in
percentage points. Equal weighting of game averages avoids letting long games
dominate skill comparisons. The two-standard-error comparison remains a
cautious descriptive signal, not a calibrated test of underlying skill.

## Validation

- `math_gate.c`: sampled action legality across 40 seeds and up to three positions
  per seed; action-union growth/stat preservation; chance terminals; horizons;
  exact large-stack DP; finite values; grade budget; terminal roots; streaming
  determinism and idempotent completion. Also run with address/undefined-behavior
  sanitizers.
- Native invariants and battle moment tests over 1,000 boards, 4,000 battles per
  tested strength pair, and frozen scripted-game outcomes.
- WASM invariants/battle tests and native–WASM board parity over 1,000 boards.
- Worker gameplay/sweep checks over 40 seeds; serial versus four-worker grading,
  resume/replay parity; scheduler, scoring, projection, migration, and skill gates.
- Paired strength smoke test, **unchanged original deal/rules**, seeds 1–120,
  2,000 simulations: original search 112/120 wins (93.3%), corrected search
  114/120 (95.0%); five improved and three worsened outcomes. This is too small
  to establish a win-rate improvement. The corrected run cost about 13% more
  aggregate game CPU time before the action-matching fast path. The two arms ran
  concurrently, so timings are indicative. Separate game-rule changes in the
  workspace are outside this comparison.

The remaining open-loop approximation shares values across survivor strengths
and bot outcomes; legal filtering does not make those nodes full state keys.
Rollout policy bias, finite budgets, and adaptive sampling still limit the
interpretation of the displayed win estimates.
