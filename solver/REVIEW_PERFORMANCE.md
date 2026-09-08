# Post-game and historical analysis performance

Measured September 6, 2026, using the browser's actual WASM engine in Node worker
threads, plus an isolated browser check of the page. No C engine, simulation
budget, grading formula, or game rules changed in this investigation.

## September 7 regression fix: repeated battle math and queued games

The rules/math correction introduced an exact overflow battle calculation for
stacks of 160 or more. Its 256-entry pair cache missed repeatedly as rollouts
visited nearby army sizes, rebuilding the entire dynamic-programming rectangle
for each miss. Native profiling of six complete games found up to 12.3 billion
DP cells rebuilt in one game (seed 16). This affected both AI play and grading.

The engine now retains the exact DP rectangle, extending it in blocks as needed.
Storage is lazy and bounded to 16 MiB per engine; larger pairs retain the original
two-row calculation. Operation order and returned values are unchanged. No search
budget, game rule, grade threshold, review version, or AI stopping rule changed.

Complete WASM games on the same machine, before/after, run sequentially with the
page's AI settings (6k floor, 150k ceiling, existing value stop), followed by full
16k–24k grading of those recorded decisions on a single engine:

| Seed | Moves | AI before → after | Serial grading before → after |
| --- | ---: | ---: | ---: |
| 11 | 20 | 14.33 → 9.17 s | 4.54 → 3.62 s |
| 16 | 44 | 82.03 → 25.17 s | 30.12 → 11.96 s |

Every root action, visit count, Q value, simulation count, played move, terminal
board and final game-dice state matched exactly. These are engine timings without
DOM work, history backlog, or competing workers, and are examples rather than a
bound for all seeds/devices. A separate 96-search sample across 16 opening/early
positions was 1.34x faster in aggregate, with exact root-stat/RNG parity. Peak WASM
heap at the 150k ceiling grew from 77.5 to 93.5 MiB per engine.

Queue fixes address additional latency independently of this compute reduction:

- Newly finished games start reviewing immediately, even while the history pump
  awaits an older game. After each complete search, the reviewer favors the open
  panel, then newer rounds; equal priorities retain FIFO order. Background work
  resumes with its completed grades intact, and the AI's one-lane throttle remains.
- The AI favors the inspected or just-finished pair, then the next dealt game and
  history. It rechecks after each complete move, instead of making a new game wait
  for an entire old game. Switching seeds and reloading replay saved AI actions
  without repeating their searches; suspended/finished worker games are deleted.

Reproduction (save the previous built WASM module before rebuilding):

```sh
node solver/latency_bench.mjs /tmp/before.mjs public/fast_engine.js 11,16
node solver/search_bench.mjs /tmp/before.mjs public/fast_engine.js 4 4000
bash solver/check.sh
```

The math gate compares cache growth, revisits and fallback values exactly against
the original two-row DP. Scheduler tests run the page's actual AI loop and verify
priority, interruption after a move, preserved history, and zero repeated searches.

## Original September 6 findings

Search dominates review time. A review replays each human decision and runs a
grading search with a 16,000 simulation floor and 24,000 ceiling. The grading
mode deliberately gives alternative moves enough visits to make comparisons
useful; the ordinary AI's early stops are inappropriate for this task.

In a 12-game, 481-decision sample, searches accounted for over 99% of accumulated
worker request time. Replaying positions used about 0.34 seconds of accumulated
request time versus 199 seconds awaiting searches across four workers. These
are concurrent request durations, not a CPU profiler's attribution or elapsed
wall time. The full review took about 50 seconds. Machine load affects timings.

The existing four-worker pool already improves latency substantially: an isolated
44-decision gate took 12.1 seconds with one worker and 3.4 seconds with four.
Parallel and serial grades were identical. This parallelism predates this change.

The historical skill graph's arithmetic is cheap at ordinary history sizes.
Using the real `skillData` function, a repeated 44-decision fixture, last-10 zoom,
and 50 iterations, data preparation averaged 0.19 ms for 100 games, 1.26 ms for
1,000, and 5.78 ms for 5,000. This measures data preparation, not canvas drawing,
DOM updates, or storage. It preserves the full trailing context before zooming.

## Improvements implemented without changing scores

- **Resume completed searches.** Partial reviews checkpoint at most once per
  second from the scoring callback and also benefit from ordinary game saves.
  A checkpoint identifies the grading version, seed, and complete action sequence.
  Reloads and retries search only its null holes. Old unversioned partial reviews
  are recomputed; existing completed reviews remain readable. In the gate, a
  checkpoint containing 29 of 44 decisions required only 15 searches and finished
  in 1.29 seconds with exactly the original grades. A complete matching cache
  requires zero searches. Work since the last successful save can still be lost.
- **Let a newly opened game use the pool promptly.** A lane releases its worker
  after every complete position, so a foreground review no longer waits for a
  whole background game. FIFO scheduling never interrupts a grading search. Each
  worker keeps at most two warm replays, identified by their full action sequence,
  so foreground/background interleaving does not repeatedly replay their prefixes.
  Evicted worker games are deleted instead of accumulating indefinitely.
- **Replay history once.** The inspector requests a complete trajectory in one
  worker message, using the existing C battle/end-turn primitives without animation
  logs. A bounded, two-entry cache shares in-flight requests and serves subsequent
  selections locally. The old inspector sent 990 requests to visit all 44 moves,
  taking 49.5 ms locally. The new path visited all 44 forward and backward in
  2.8 ms with one request. These timings exclude browser painting; the request
  reduction is deterministic. Replays do not retain another game in the worker
  or change the live game's subsequent dice or topology.
- **Combine visible updates.** Multiple review completions within a frame share
  a single list/chart redraw. Failure handling waits for all scoring lanes to
  release their workers and keeps completed positions available to the retry UI.
  Incomplete searches are rejected rather than cached as complete grades.

These changes improve history navigation, interruptions, and contention. They do
not halve the CPU needed for an uninterrupted first review of a new game.

## Tested and rejected: halving every grading budget

`review_bench.mjs` records full games on seeds 11–22. Seed 11 uses the light AI;
other seeds inject end turns, arbitrary legal choices, or third-ranked choices
every third decision. The sample contains six wins and six losses. The same
recorded actions are then graded with three budgets:

| Budget | Total simulations | Elapsed, four workers |
| --- | ---: | ---: |
| Current: 16k–24k | 9,291,648 | 50.10 s |
| Half: 8k–12k | 4,673,024 | 24.12 s |
| Deeper reference: fixed 96k | 46,176,000 | 220.69 s |

The half budget changed 38 severity labels among 223 decisions considered live
by either the current or half-budget search. The mean absolute change in estimated
win-percentage loss was 1.96 percentage points, the 95th percentile was 8.76,
and the maximum was 17.50. Nine decisions changed their live/decided classification.

A concrete miss: seed 17, move 20 was a **21.27-point blunder** at the current
budget, **3.77 points / OK** at half budget, and **22.25 points / blunder** at 96k.
This is a meaningful accuracy regression despite the appealing twofold speedup.

Against the deeper reference, mean absolute gap disagreement was 2.33 points for
the current budget and 2.97 for half budget; 95th-percentile disagreement was
10.09 and 12.06 respectively. Each comparison uses the union of its live decisions,
so its denominator differs slightly. The reference uses the same private random
stream and a deeper search; it is a stability reference, **not ground truth**.
The test uses synthetic play, not the user's saved histories. These results also
show that current grades have uncertainty, particularly on difficult decisions.

An initial three-game sample with mostly strong choices appeared much safer
(0.25-point average change, one label change). The broader sample is why the
smaller budget was not enabled.

## Next experiment for a larger first-review speedup

Concentrate grading effort on the played move and credible best alternatives,
rather than enforcing the same visit floor across every root action. This needs
a dedicated search experiment: root allocation and burn-in affect Q estimates,
so reducing work on other actions can change both the chosen reference and the
played move's grade. Validate with diverse recorded human games and deeper
searches on independent random streams, measuring missed blunders and individual
large errors as well as average error.

A cheap first pass can also provide provisional feedback while full grading
continues. That reduces time to first feedback, not total computation. Refining
only scores near a severity threshold is insufficient: the missed blunder above
looked safely below the first threshold. Aggressively skipping apparently decided
positions needs similarly careful validation.

## Reproduce and verify

```sh
node solver/review_scheduler_gate.mjs
node solver/review_gate.mjs 11 4
# Optional baseline path after the worker count: saved pre-change review.js, with an .mjs extension.
node solver/review_gate.mjs 11 4 /tmp/review-before.mjs
node solver/worker_gate.mjs 40
node solver/review_bench.mjs 11,12,13,14,15,16,17,18,19,20,21,22 4 96000
```

The benchmark writes full fixtures, per-decision results, and comparisons to
`/tmp/nw-review-perf/benchmark-12.json`. Avoid competing workloads for timing
comparisons; simulation counts and seeded results are deterministic.

Checks cover exact pre-change/parallel review parity, sparse checkpoint resume,
cache invalidation, foreground scheduling, failures and truncated searches,
every replayed board including terminal state, live-game dice/topology isolation,
and worker-game deletion. The 40-seed worker gate passed. An isolated browser
fixture verified a saved partial review filling its holes, both history tabs,
direct selection and backward stepping, with no console errors. No native or
WASM rebuild was needed because engine code and exports were unchanged.
