# Hard test set — live-lost openings as the search benchmark (2026-07-02)

Two-part winrate push: (1) turn every opening we LOST live into a scored,
banded test set; (2) paired-seed A/B heuristic/search ideas against the band
where search actually has leverage.

## Part 1 — the instrument

`solver/iphone_data/hard_set.py` harvests every clean, standard, deduped
round-0 opening that lost in a live series (all `runs/series_*.jsonl` +
`loop_series.jsonl`), then re-scores each offline with K fresh dice seeds
(same engine, private sim stream, no seed exploitation):

    uv run python hard_set.py --score --seeds 24 --sims 4000 --min-sims 1024

The winnable% splits the set into **dice-bound** (<40%), **contested**
(40–85%, THE test set), and **easy** (>85% — the live loss was an in-game
dice/OCR/execution one-off, not the opening). `--min-sims` uses the adaptive
visit-margin stop (move-identical to the fixed budget, ~2.5x cheaper).

`solver/iphone_data/hard_ab.py` replays a band with the same (board, seed)
pairs under one engine config per run and compares arms PAIRED (McNemar z on
discordant pairs) — small real effects stay visible through battle-dice noise.
Engine-code variants are selected with `NW_ENGINE_SO=…`; exposed levers are
flags (`--sims/--min-sims/--c-puct/--nroll/--deepthink/--value-stop`). (A
one-off `fast_engine_hx.c` experiment build carried the progressive-widening /
FPU-reduction setters for the arms below; it was deleted once both levers were
refuted — the tables here are the record.)

### Scored set, REAL decompiled battle (fair-coin attrition, 2026-07-02)

88 lost openings × 24 seeds @ 4000 sims: **mean winnable 84.9%** —
**2 dice-bound / 22 contested / 64 easy**. The headline: our live losses are
overwhelmingly NOT doomed deals; ~73% of lost openings we'd win ≥85% of
replays. The old fitted-battle scoring (same harvest) gave 84.4% mean,
2/35/51 — the real battle makes the game *easier to convert* on these
openings (g67, the old 27.5% nightmare, scores >85% under the real mechanic).

## Part 2 — paired A/B on the contested band

### Fitted-battle arms (35 openings × 40 seeds = 1400 games/arm, 4000 sims
adaptive 1024; run before the real battle shipped — internally consistent.
Arm outputs are regenerable via `hard_ab.py`; these tables are the record.)

| arm | winrate | vs base | z |
|---|---|---|---|
| base | 72.8% | — | — |
| pw c=2 α=.5 min=2 (mild, binds only deep) | 73.1% | +192/−187 | +0.26 ns |
| fpu 0.15 | 72.6% | +193/−195 | −0.10 ns |
| pw c=.3 α=.4 min=1 (aggressive, binds at root) | 68.4% | — | ≈ −3 HURTS |
| **sims 32k (8× compute)** | **76.7%** | **+195/−140** | **+3.00 SIG** |

- Progressive widening: mild = null, aggressive = −4.4pt. Clean dose-response
  confirming the C1-priors lesson — trusting C1 to *restrict* the tree hurts;
  the plain search already finds those moves.
- FPU reduction: null.
- **8× compute = +3.9pt (z=3.0)** — first significant positive lever of the
  whole campaign. The aggregate "sims-scaling is flat" result was a mixture
  artifact: easy + dice-bound games dominate aggregates; the contested band
  is genuinely compute-responsive. Also validates the instrument (a real
  +4pt effect is detectable at n=1400), so the nulls above are real nulls.

### Real-battle arms (22 openings × 40 seeds = 880 games/arm, 4000 sims
adaptive 1024 unless noted; wallclock is for the whole 880-game arm, 9 workers)

| arm | winrate | vs base | z | wallclock |
|---|---|---|---|---|
| base | 66.2% | — | — | 246s (1.0×) |
| nroll4 (4 rollouts/leaf) | 69.9% | +162/−130 | +1.87 ns | 864s (3.5×) |
| **sims 32k ceiling, visit-margin stop** | **72.6%** | +149/−93 | **+3.60 SIG** | 1625s (6.6×) |
| **sims 32k ceiling, deepthink stop (r=3, minvis=2048)** | **73.2%** | +145/−84 | **+4.03 SIG** | 1144s (4.7×) |
| sims 150k ceiling, deepthink stop (same) | 72.2% | +152/−100 | +3.28 SIG | 3188s (13×) |

- **Compute replicates under the real battle, stronger: +6.4–7.0pt (z=3.6–4.0).**
- dt32k vs sims32k paired: +46/−41, z=+0.54 — deepthink allocation reaches
  full-32k quality at ~0.7× the cost. The old deepthink live study (n=40,
  "settled null") was underpowered, not wrong about selectivity: on a
  compute-responsive band the reallocation genuinely converts.
- nroll4 at 3.5× wallclock sits on the same efficiency curve as plain sims
  (interpolated sims-only at 3.5× ≈ +4pt) — leaf averaging is not a distinct
  lever, it's just another way to buy compute.
- Per-opening deltas (base → 32k) are heterogeneous: g89 +22.5, 200g-g7
  +22.5, 16k-g61 +22.5, afterfix-g7 +15, several ≈0. Compute helps a specific
  minority of contested positions a lot, most a little.
- **Saturation at ~32k**: dt150k vs dt32k paired = +48/−57, z=−0.88 — the
  band's compute response is 4k→32k +7pt, 32k→150k flat. What's left at 32k+
  (~27% of band games) is dice, not search depth.

### What this means for live

Live already runs adaptive 2k–150k with the absolute visit-margin stop, so
contested moves already receive ≥32k sims — this is consistent with live
sitting at ~94% with mostly dice-bound losses. The wins here are: (a) the
hard-set instrument itself (cheap, powered, position-targeted A/B), (b) the
demonstration that the "flat scaling" aggregate was a mixture artifact, and
(c) deepthink-style relative-margin stopping as a ~30% compute saver at equal
strength (candidate for live latency, not win-rate).

## Ops notes

- Background-shell pools get macOS-QoS-clamped to E-cores (~16% CPU/worker).
  Launch long evals with `nohup … &` from a normal shell: ~95%/worker, 5×.
- `hard_ab` pair keys are md5 of the sorted board tuple — `hash()` differs
  across processes.
