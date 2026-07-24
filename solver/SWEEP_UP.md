# Sweep-up: the offer was unsound, and the threshold was never the lever

*2026-07-23. Triggered by max losing a swept game after ~50 games of use, and asking
whether to raise the threshold.*

The web pages' **sweep-up offer** auto-plays the rest of a won game with a simple
mop-up policy (the real bot's aggression rule: strongest attacker first, hit any
strictly weaker adjacent enemy, else end turn). It shipped gated on the search:
offer the sweep when **every root move wins > 99.95%** (raised from 99.8% two commits
earlier, which changed nothing — see below).

Measured over full games with the exact live search configs
(`solver/sweep_audit.py`, 190 games, 200 mop-up playouts per offered position):

| | offers | fired at (median) | mop-up loss rate |
|---|---|---|---|
| shipped h2h gate (grade, 4000–8000 sims) | 188/190 games | **turn 3, 10 RED nodes** | **5.29%** ±0.23 |
| shipped index gate (no grading mode) | 43/190 | turn 3, 10 nodes | 0.91% ±0.20 |

A faction needs **24** nodes to win. The offer was appearing at ten nodes on turn
three — in essentially every game — and the mop-up it authorized threw the game one
time in nineteen. One loss in ~50 uses is exactly what that predicts.

## Two independent defects

**1. The gate measured the wrong player.** `q` is the search's win estimate *under
search play*. The button then hands the game to a much weaker greedy policy for the
whole rest of the game. Same positions, same dice: playing the **search's** move
instead lost **0 / 2256** playouts where greedy lost 5.3%. The certificate simply did
not cover the policy being run.

**2. The gate had no resolution, so the threshold was inert.** `q` is the mean of 0/1
rollouts, so its quantum is `1/visits`: a root child can report `1.0`, or at most
`1 - 1/v`. Worse, grading mode (`uct_set_grade`) reports Qs from *after* a snapshot
taken at `max_sims/2`, while the decisive value-stop (`q >= 0.97`, ≥512 visits) ends
the search ~96 sims later **in exactly these near-won positions** — so each root
child's Q averaged ~20 rollouts. `q > 0.9995` therefore meant nothing more than *"none
of ~20 rollouts happened to lose"*. Both 99.8% and 99.95% are the same test, and no
threshold below 1.0 can resolve 99% from 100% off 20 samples. (A 48k-sim grading
search with the stops off fires on only **16/142** of the same positions, and on
**5/104** of the ones where the mop-up actually lost.)

This is also, in fairness, grading mode asking to be misused: its contract says the
decisive value-stop is fine to leave on because *"the position is decided, every move
ties, the review's dead-filter drops it anyway"*. The sweep gate was built on the one
readout grading mode declares out of scope.

## The fix: certify the policy you are about to run

`sweep_best_move` / `sweep_certify` in `fast_engine.c`. The certificate **plays the
mop-up policy itself to the end N times on fresh dice** and passes only if at most
`max_losses` of them lose. It answers the actual question — *"if I press this, do I
win?"* — and costs about one rollout per trial, so it is ~100× cheaper than the
4000–8000-sim search it replaces (**median 0.1 ms, worst 8.6 ms in WASM** for 1000
trials, `solver/worker_gate.mjs`). The browser also stops keeping its own copy of the
rule: both the certificate and the executed move come from that one C function.

Gate strength, measured on positions each variant itself selected, with the truth
drawn from a **disjoint dice-seed range** (`solver/sweep_variants.py`, 58 games):

| gate | fires | fired at | moves left | mop-up loss rate |
|---|---|---|---|---|
| shipped q-gate | 57/58 | turn 2, 10 nodes | 28 | 6.14% |
| q-gate, honest grading window (`max_sims == sims`) | 57/58 | turn 3, 11 nodes | 25 | 1.25% |
| q-gate, 16k grading | 57/58 | turn 3, 12 nodes | 23 | 0.97% |
| certificate, 400 clean playouts | 57/58 | turn 3, 12 nodes | 23 | 0.145% |
| **certificate, 1000 clean playouts** | 57/58 | turn 4, 13 nodes | 20 | **0.070%** |

The feature survives: it still fires in 57/58 games and still saves ~20 RED actions.
It just fires a turn later, when the game really is over.

## Re-certifying mid-sweep closes the rest

The certificate covers the position it was run on; the dice keep rolling as the
mop-up plays. So the sweep re-certifies before **every** action (400 trials) and hands
the game back if it fails. `solver/sweep_final.py`, 62 offered positions × 200 sweeps
each (12400 sweeps):

| | won | handed back | LOST |
|---|---|---|---|
| gate only, no re-check | 12390 | 0 | 10 (0.081%) |
| re-check, bail if **>0** of 400 lose | 7271 | 5129 (41%) | **0** |
| re-check, bail if **>2** of 400 lose *(shipped)* | 11538 | 862 (7%) | **0** |
| re-check, bail if >4 of 400 lose | 12011 | 389 (3%) | **0** |

The bar is deliberately looser than the gate: bailing on a single unlucky playout in
400 hands back positions still winning ~99.5%, which is how the strict bar reaches a
41% hand-back rate for no measurable safety gain.

**Shipped:** offer at 1000/1000, continue while ≤2/400 lose, bail with *"Sweep
stopped — this is no longer a sure win. Your move."*

## Fallout worth knowing

- In head-to-head, swept moves are recorded and **scored as your decisions**. Under
  the old gate they were live positions, so a greedy bot's choices were being graded
  as the player's skill readout. An honest gate fixes that too: certified positions
  are decided, and the review's live-decision filter (best-Q in 2–98%) drops them.
- The sweep no longer needs the search at all, which removes head-to-head's one
  documented exception to *"your worker issues zero searches while you play"*.

## Gates

- `validate_fast.py` / `wasm_gate.mjs`: the certificate rejects openings, accepts a
  29-of-30-nodes position, matches the mop-up rule, and **leaves the real mb32 dice
  stream untouched** (it rolls on the private sim stream — otherwise merely *offering*
  a sweep would change the game's dice).
- `worker_gate.mjs` (new): emulates a Web Worker in node and drives
  `engine.worker.js` over N seeds through the pages' own request sequence, asserting
  every accepted sweep either finishes the game or bails out through the re-check.

## Not fixed (open)

`GRADE_MIN_HALF = 16` in `fast_engine.c` lets grading mode report a second-half Q off
16 rollouts, and the snapshot is taken at `max_sims/2` regardless of when the search
actually stops. Nothing depends on it now that the sweep doesn't (the review filters
decided positions, and live positions run the full 16k–24k budget), but it is a trap
for the next consumer. Raising the floor or snapshotting relative to actual spend
would change validated grading numbers — re-run `grade_eval.py` before touching it.
