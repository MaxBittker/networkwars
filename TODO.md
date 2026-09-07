# Gamefeel restoration

Reference: `~/Downloads/ScreenRecording_09-06-2026 23-16-11_1.MP4`
(95.6 seconds; reviewed at 5-second intervals and quarter-second battle frames).

- [x] Compare the reference with the renderer and turn replay.
- [x] Restore the dark teal-to-olive background, compact octagonal counters,
      brighter blue/green palette, shaded node bodies, and fine dotted links.
- [x] Make both battle participants light up with dark, readable numbers;
      highlight direction, show the actual loss sequence, then hold the outcome.
- [x] Give bots the same readable battle replay as the player; separate faction
      handoffs and reinforcement pulses, and update counters as captures happen.
- [x] Keep saved speed preferences (Classic default, Fast, Instant, Slow), drag
      targeting, sweep-up, duplicate AI play, replay, grading, and persistence.
- [x] Verify mobile/desktop visuals and animation completion/fast-forward behavior.
- [x] Benchmark MCTS improvements against the original with identical seeds,
      budgets, visits, and Q values; retain only measured, behavior-preserving work.
- [x] Remove duplicated animation/search work and document the resulting structure.
- [x] Rebuild WASM; run native, WASM, worker, and review regression gates.

## Reference observations

- At 5s, nodes have dark tops, luminous lower edges, thick colored octagonal
  rims, narrow white numbers, and small gaps of finely dotted green links.
- At 9–17s, green's battles take roughly 1–2s each: both participants become
  pale, their connecting link lights up, losses tick down, ownership transfers,
  then the next attack starts. This is also how the later factions play.
- Reinforcement is a distinct pulse across the receiving nodes after attacks.
  The active faction counter follows the turn, and counts track each capture.
- Expert features belong around this readable board; the battle rules and
  private search RNG remain the C engine's responsibility.


## Completion and verification

- Shared battle replay for all factions; 240ms focus, 140ms per recorded loss,
  300ms settle; separate 520ms reinforcement pulse and faction handoffs.
- Classic keeps the existing `medium` storage key; Fast is 4×, Slow is 0.5×,
  Instant skips replay. A per-replay skip button leaves the saved speed unchanged.
- Node bloom/shading is cached, positions are cached between view/layout changes,
  and animation frames avoid repeated layout measurements and blur operations.
- Mobile checked at 390×844 and 320×568, plus desktop. Selection, player combat,
  bot turns, live counters, saved Fast/resume, and skipping checked in the browser;
  no console errors. Compact layout now clears the badge with the whole top node.
- Native gate: 1,000 seeds, 12 golden games, battle, grading, and sweep checks pass.
- WASM gate: 1,000 seed parity/determinism and battle/search/sweep checks pass.
- Worker gate: 40 seeds pass, including 4 sweep handbacks.
- Review gate: 44 decisions; serial and four-worker grading identical.
- Board gate: 22 captures / 8 repels, loss sequence, reinforcement, speed changes,
  skip/exception cleanup, and compact-layout clearance pass.
- Search benchmarks: 288 paired searches on each of native and WASM, all root
  statistics and game RNG identical. Roughly 1% faster in this local sample;
  maximum-budget WASM heap 99.38 → 79.44 MiB (about 20% less). See solver README.

## Further cleanup opportunities

The next useful extraction is the match persistence/model code from `index.html`
into a standalone module, with saved-game migration fixtures. Gradual search-pool
allocation could reduce ordinary-position memory further, but must preserve
chance-child pointers across reallocations. Both deserve their own focused change;
this pass removes duplicated replay, repeated search calculations, and the scorer's
wrapping global stamp without changing play or stored match data.

## Typography and motion correction

- Replaced condensed/scaled node and counter lettering with normal-width numerals.
- Removed all animated node/number resizing; casualties and reinforcement affect
  brightness only, with fixed sprite bounds throughout the replay.
- Attack arrows now travel from source to defender along the connecting edge on a
  continuous 420ms clock, scaled by the saved speed setting. Preview arrows stay
  at the target. The active link's core is dimmer so the moving arrow remains clear.
- Added checks for arrow travel in all eight directions, rim clearance, fixed node
  bounds, unscaled lettering, and speed-adjusted arrow timing. Board gate passes;
  refreshed preview verified with no console errors.

## Frame-sampled color pass

- Sampled idle bodies, rims, highlights, attacking fills and numeral inks for all
  five factions; compared rendered nodes beside the extracted frames.
- Added separate idle/attacker/defender/reinforcement styles, stronger saturated
  combat halos, thinner white combat rims, and attacker-colored defender glow.
- Preserved normal-width numerals, fixed node size, moving arrows and saved speeds.
- Recorded timestamps, coordinates and RGB samples in `solver/NODE_VISUAL_REFERENCE.md`.
- Board gate passes; refreshed the saved game between moves and verified no console errors.
