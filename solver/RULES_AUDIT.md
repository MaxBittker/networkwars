# Game-rules audit — 2026-09-07

Compared the local iOS artifact with `fast_engine.c`, its Python/JavaScript
bindings, and the browser's game/replay routes. Visuals, random-number-generator
identity, and search tuning were outside this audit. Existing concurrent search
and grading edits were preserved.

The readable C# files in `ipa_decompile/decompiled/` are mostly reference stubs
whose method bodies contain only `ret`. They establish names/signatures, not
behavior. Behavioral evidence came from the corresponding Mono-AOT ARM64 methods
in `ipa_decompile/re/`, plus actual execution of the original battle routine in
Unicorn 2.1.4. This is not a claim of complete, seed-for-seed iOS equivalence.

## Findings and changes

| Area | Original / expected rule | Before this audit | Result |
|---|---|---|---|
| Starting-army adjacency | Large armies are placed as connected single/pair/triple elements, followed by one-army fillers. | Grew faction territories first, then shuffled strengths onto them. A required three-stack group could be split across the map. | Fixed for new games. |
| Attack legality | Attack an adjacent enemy from a stack of at least two. Humans may attack an equal or stronger enemy. | The page normally offered legal moves, but the worker executed arbitrary attack requests, even nonadjacent, friendly, enemy-origin, or out-of-range ones. | Validated at the worker boundary and guarded exported C battle operations. Rejection consumes no dice and changes no armies. |
| Ended games | A finished game accepts no further actions. | Extra attack/end-turn requests still mutated the board; imported terminal boards were initialized as active. | Fixed. Terminal views also return no legal moves. |
| Reinforcement fallback | Budget equals the largest component's node count. Visit components largest first until a border can receive it. | Discarded the entire budget when the largest component had no border. | Fixed for disconnected imported boards. Ordinary connected unfinished games are unaffected. |
| Imported boards | One valid owner/army count per distinct indexed node/cell. Zero armies is legal. | Duplicate/missing IDs, duplicate cells and invalid owners/negative strengths could silently become a different game state. | Reject malformed boards and recognize terminal boards on import. |
| Saved games | Resume, scoring and inspection must reconstruct the actual played board and dice. | Seed-only histories had no generator version. Changing placement would reinterpret all past actions. | Added version 2 for new rounds and preserved version 1 for unversioned historical rounds. |

### Opening placement

`MapMaker.makeArmiesBuildList` at `0x1014689a0` specifies:

| Large stacks | Placement elements |
|---|---|
| `[8,8]` | Two singles or one adjacent pair, chosen by a fair coin. |
| `[6,6,5]` | One connected triple. |
| `[5,5,4,4]` | An adjacent `[5,5]` pair and an adjacent `[4,4]` pair. |
| `[4,4,4,4,3]` | A connected `[4,4,4]` triple and an adjacent `[4,3]` pair. |

`getBuildCluster` (`0x101467b30`) / `findBuildCluster` (`0x101467e20`)
search shuffled unbuilt islands. A triple can be a fork or a path; requiring a
triangle would be wrong. `buildElementSet` (`0x1014675d0`) assigns armies to that
group. `buildSingleArmies` (`0x101467110`) fills remaining cells with shuffled
faction labels, bringing every faction to six nodes and twenty armies.

Our new generator enforces those grouping rules. Failed group placement retries
the map rather than silently splitting a group. Groups and fillers may touch
other nodes of the same faction: the original does **not** require them to stay
separate components. The earlier notes' wording about “isolated singles” was
too strong.

We retained existing fitted template sampling and topology sampling, as requested
for RNG differences. The original couples each faction's large-stack count through
a shared Gaussian singles count; our draws remain independent. Original topology
generation selects live cells and rejects disconnected configurations; our
connectivity-preserving deletion reaches a connected 30-cell graph differently.
Thus the allowed army values, totals, connectivity and grouping match, but the
distribution of openings is still approximate. Placement retries can also alter
the realized frequencies relative to the template sampling weights.

### Reinforcement

`Utils.reinforce` (`0x10145f430`) obtains the first sorted component's size at
`0x10145f624–638`, stores that budget in `w23`, and iterates components. At
`0x10145f880–894`, an empty border skips the inner allocation loop without spending
the budget. The outer loop proceeds while the budget remains (`0x10145f8b8–8dc`).
Each placed army decrements it at `0x10145f710`.

Example: a disconnected faction has a closed component of three nodes and a
two-node component bordering an enemy. The old engine awarded zero armies. The
correct fallback awards three armies to the latter component's border. On a
connected board, a proper owned component necessarily has an enemy neighbor, so
this edge case never changes ordinary pre-victory turns.

The original shuffles component discovery and border order. We retained
deterministic node-ID ties and remainder order, consistent with the requested RNG
scope. These choices can affect particular outcomes; they are not bit-exact iOS
ordering.

## Rules that already matched

- **Battle:** two guarded attacker pre-fires, then paired attacker/defender coins;
  a defender still fires in the round where its last army falls. Capture requires
  surviving attacker strength greater than one and defender strength zero. The
  source retains one, and a captured node receives surviving attacker strength
  minus one. Original addresses: `doAttackConsole` `0x1014604e0`, `symBattle`
  `0x1014614b0`; see `REAL_BATTLE_DECOMPILED.md`.
- **Zero-army defenders:** simultaneous final casualties can leave a defender
  with zero armies while retaining ownership. The next legal attack captures it
  without a coin draw. Such nodes still count toward components and victory.
  The code was correct; `DESIGN.md` incorrectly said all owned nodes had ≥1 army.
- **Bots:** a turn-start snapshot, strongest-first pass, smallest adjacent enemy,
  and a capture chain following the moved stack. Equal-strength attacks are
  refused by bots; humans are not restricted this way. Repels end the chain.
  Source: `OpponentAIOriginal.opponentMove` `0x10146d970`, `okAttack`
  `0x10146dfc0`, `getSmallestEnemy` `0x10146ce30`.
- **Turn structure:** red reinforcement, then green/yellow/blue/purple attack
  turns with their own reinforcement; eliminated factions are skipped. Animated
  turns and atomic replay use the same C rules.
- **Victory and elimination:** `Utils.winner` (`0x10145ed40`) compares node count
  against the configured threshold, ≥24 in the supported game configuration.
  `Utils.loser` (`0x10145ecf0`) tests zero owned nodes. Our red-elimination loss
  and capture victory checks agree. The one-faction-left shortcut on smaller
  imported graphs is an existing extension, not a distinct standard-board rule.
- **No live turn/army cap:** the search's 300-turn horizon and probability-table
  bounds are solver approximations, not limits imposed on played games.

Exact original bot list order remains unverified. The comparator is strict, so
first-found ties are real, and different adjacency/list order can change a move.
Our node-ID/adjacency order is documented as an approximation; the earlier
description of the original order as definitely history-dependent was not proven
by this audit. No speculative reorder was introduced.

## Compatibility and validation

New rounds record `rules: 2`. Historical rounds lacking that field use
`new_game_legacy` through resume, AI completion, review and inspection. Version is
part of replay-cache/checkpoint identity. A newly entered bare seed uses the new
generator; its starting board may differ from a historical round with that seed.

Validation completed:

- 3,000 original ARM64 battles versus the current C implementation, fed identical
  hit/miss sequences: exact ownership, both survivor counts, and consumed coin
  counts matched. Included initially zero-army defenders.
- `rules_gate.c`, with AddressSanitizer and UndefinedBehaviorSanitizer: 10,000
  openings, required strength-specific groupings, reinforcement allocation and
  fallback, bot chains, human/bot attack differences, illegal actions, terminal
  guards, and zero-army capture.
- `legacy_rules_gate.py`: a frozen pre-audit digest of 1,000 seeds, complete
  topology/coordinates/armies/dice, and up to eight subsequent bot rounds matches.
- `validate_fast.py`: 1,000 boards, exact-distribution battle checks, 12 intentionally
  re-frozen version-2 golden games, grading and sweep checks.
- `validate_wasm.py`: 1,000 native/WASM board matches, determinism and battle checks.
- `rules_worker_gate.mjs`: invalid requests leave state/dice unchanged; terminal
  imports, bad imports, and both saved-game versions behave correctly; animated
  and batch-replayed trajectories agree.
- `worker_gate.mjs`: 40 complete game/sweep flows pass, including sweep handbacks.
- `review_gate.mjs`: serial/four-worker review and resumed checkpoints match;
  every inspected/replayed position matches the played board.

Both native and browser builds were rebuilt. Historical win-rate measurements
refer to the earlier opening distribution; this audit does not re-estimate the
solver's win rate on the corrected placement.
