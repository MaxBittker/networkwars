# The real bot turn, decompiled (2026-07-17)

Max noticed in live play that a bot always continues attacking with the stack it
just moved, and never returns to a stack it had already used that turn. Both
observations are correct — this recovers the actual opponent-AI loop from the
shipped IPA and it is now the engine's `run_bot_turn` (fast_engine.c).

## Where it lives

Same pipeline as REAL_BATTLE_DECOMPILED.md: method names/indices from the
`NetworkWars.Standard.dll` metadata (`ipa_decompile/tokentool`), idx → ARM64
address via the Mono AOT `method_addresses` bl-table (`re/find_table.py`),
per-method asm sliced from `re/module_all.txt` into `ipa_decompile/re/ai/`:

| idx | method                                      | addr        |
|-----|---------------------------------------------|-------------|
| 253 | `Utils.selectOpponentAI`                    | 0x10145f9e0 |
| 383 | `OpponentAIBase.opponentMove`               | 0x10146cdd0 |
| 385 | `OpponentAIBase.getSmallestEnemy`           | 0x10146ce30 |
| 386 | `OpponentAIBase.getSmallestEnemyNice`       | 0x10146cf40 |
| 388 | `OpponentAINiceEarly.opponentMove`          | 0x10146d160 |
| 389 | `OpponentAINiceEarly.okAttack`              | 0x10146d780 |
| 395 | `OpponentAIOriginal.opponentMove`           | 0x10146d970 |
| 396 | `OpponentAIOriginal.okAttack`               | 0x10146dfc0 |

## The turn loop (ground truth from `OpponentAIOriginal.opponentMove`)

```
foreach island in myIslands.OrderByDescending(i => i.armies):   # ONE pass over a
                                                                # pre-attack snapshot
    enemy = getSmallestEnemy(island)     # smallest adjacent enemy; strict <, so
                                         # ties -> first in adjacency-list order
    while enemy != null and okAttack(island, enemy):
        won = doAttack(island, enemy)    # the decompiled fair-coin battle
        if not won: break                # repel ends the chain
        island = enemy                   # CHAIN: keep attacking with the stack
        enemy = getSmallestEnemy(island) # that just moved
```

- `okAttack(a, d)` = `a.armies >= 2 && a.armies > d.armies` (strictly bigger).
- The `foreach` source is buffered before the first attack (LINQ OrderBy
  semantics), so islands captured mid-turn are reachable only through a chain,
  a stack is never revisited, and attacks that open up later in the turn (e.g. a
  repel leaves a small remnant next to an earlier island) are NOT taken.
- No RNG anywhere in move selection: ordering is a stable sort over the player's
  island list; target ties go to the first adjacency. (Sort direction is an
  rgctx LINQ slot the asm doesn't name; strongest-first is confirmed by the live
  capture-phase audit — the "cascades" it observed were exactly these chains.)

## Which AI variant ships

`Utils.selectOpponentAI` picks a class from the `OAIType` settings string
(`"default"` / `"BASE"` / `"NICEEARLY"`, fallthrough = the `"default"` branch).
`OpponentAINiceEarly` is the same loop but goes easy on the human early:
`okAttack` refuses `enemy.owner == human && enemy.armies > 2` while
`Utils.turn < 3` and uses `getSmallestEnemyNice` while `turn <= 4`.

The live default is **`OpponentAIOriginal`**: across the 100-game live series
(`iphone_data/runs/series_100game_20260629_182041.jsonl`) bots captured red
nodes holding 3–6 armies in rounds 0–2 eleven times — moves NiceEarly's mercy
rule forbids.

## What shipped (fast_engine.c)

`bot_turn_begin/bot_turn_next` expose the turn as a cursor (snapshot + sorted
island list + chain head packed in an int32 buffer) so the browser worker can
replay a bot turn attack-by-attack; `run_bot_turn` drives the same cursor, so
stepped and atomic turns are bit-identical (validated native + WASM, 200/60
seeds). Ties are node-id / adjacency order — a deterministic approximation of
the real island-list order, which is game-history-dependent and not worth
tracking. Golden seeds re-frozen in validate_fast.py.
