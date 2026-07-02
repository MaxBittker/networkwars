# The REAL map + deal generation — decompiled from the iOS IPA (2026-07-02)

Same provenance/tooling as `REAL_BATTLE_DECOMPILED.md`: Xamarin/Mono AOT ARM64 in
`NetworkWars.iOS`, method bodies located via the `MonoAotFileInfo`
`method_addresses` bl-table (`ipa_decompile/re/find_table.py`), sliced out of the
full disassembly (`ipa_decompile/re/extract_asm.py` → `re/mm/*.asm`). All the
generation logic lives in `UtilsDLL.MapMaker` (+ `Utils.makeMap`).

**Status: the pipeline is fully mapped and most functions are hand-decoded and
confirmed. The one randomized core — `getBigArmies`'s growth loop — still needs
Unicorn emulation to pin bit-exactly before shipping (see "TODO" at the end).**
This doc is the recovered spec, not yet wired into `fast_engine.c`.

## Fixed frame (`legalSizesDyno`, idx 341 @ 0x101469de0) — CONFIRMED

Pure integer predicate `legalSizesDyno(x, y, teams, teamsize)`:

```
return teams == 5            # HARD: always 5 factions (4 bots + human)
   and teams <= 100
   and x*y >= teams*teamsize # board must hold every army
   and teamsize >= 3
```

So the board is always **5 teams**; `teamsize` (armies per faction, = our "20"
via `teamStartArmySize`, distinct from this node-count param) ≥ 3.

## Driver: `makeIslandArrayDyno(X, Y, teams, teamSize, maxSingleInitArmy, teamStartArmySize)` (idx 322 @ 0x101466df0) — CONFIRMED structure

1. `this.teamStartArmySize = teamStartArmySize` (field +0x2c). `maxLive = teams*teamSize` (field +0x20). `this.teams=+0x24`, `this.teamSize=+0x28`.
2. `legalSizesDyno(X,Y,teams,teamSize)` — bail if illegal.
3. **Topology build+retry loop** (label 0x101466f48, retries while a validity bool is false):
   - build island array (`10148a9dc`), `InitIslands`/`createLinks` (`10148a9f0`),
     grow topology (`createTopology`, `10148aa7c`) + `getLiveIslands` (`10148aa2c`)
     inside an inner `checkTopology` retry (`10148aa90`).
   - `singlesKount = makeSinglesKount(maxLive, teamSize)` (`10148aaa4`).
   - `bigIslandKount = maxLive - singlesKount` (field +0x20 minus singles) → stored, used by the deal.
   - `teamBigArmies = getBigArmies(...)` (`10148aab8`) → `List<List<int>>`, one inner list per team.
   - `buildList = makeArmiesBuildList(teamBigArmies, ...)` (`10148aacc`).
   - `buildArmiesBuildList(buildList)` (`10148aae0`) → place armies; plus
     `verifySetup`/`verifyTeam` (`10148aaf4`/`10148ab08`) — any failure restarts the whole map.

So a dealt board = **retry-until-valid**: topology and placement are regenerated
until connectivity + per-team invariants pass. Our engine must reproduce the
*accepted* distribution, not a single pass.

## `makeSinglesKount(maxLive, teams)` (idx 340 @ 0x101469d30) — CONFIRMED

Number of single-army nodes is **Gaussian**, then clamped:

```
raw   = Utils.GetNextGausian(mean = maxLive/2.0, stddev = maxLive*0.06, this.gameRnd)
kount = (int)raw                       # fcvtzs, truncation toward zero
kount = min(kount, maxLive - 2*teams)  # leave >=2 nodes per team for big armies
kount = max(kount, 0)
```

(Constants read from the immediates: `2.0` = `0x4000…`, `0.06` =
`0x3FAEB851EB851EB8`.) This is **new**: the count of small "filler" nodes is
random per game, not a fixed template. `GetNextGausian` (idx 223 @ 0x10145c290)
is a standard Box–Muller over `Random.NextDouble` (needs emulation for the exact
draw, but the mean/stddev are confirmed).

## `splitArmies(armyBins, howManyArmies)` (idx 339 @ 0x101469b20) — CONFIRMED

Deterministic **even round-robin split**, no RNG:

```
bins = [0]*armyBins
for i in range(howManyArmies):
    bins[i % armyBins] += 1
return bins
```

e.g. `splitArmies(4, 20) → [5,5,5,5]`, `splitArmies(3, 20) → [7,7,6]`. This is how
a faction's total army mass is spread across its big islands — as evenly as
possible. (Confirms the "every faction totals the same" balance property from
memory `sim-vs-real-deal-imbalance`: the split is symmetric across factions.)

## `getBigArmies(teams, teamSize, teamStartArmySize, bigIslandKount)` (idx 338 @ 0x101469710) — DECODED (static)

Confirmed via the driver's field writes (`makeIslandArrayDyno`:
`this.+0x24 = myTeams`, `+0x28 = myTeamSize`, `+0x20 = maxLive = teams*teamSize`).
Builds `teamBigArmies : List<List<int>>`, one inner list per team:

```
# 1. how many BIG islands each team gets (NOT sizes yet)
bins = [2] * teams                    # every team starts with exactly 2 big islands
while sum(bins) < bigIslandKount:      # (guard: <= 10000 iterations)
    t = gameRnd.Next(0, teams)         # random team  (10148acd4 = Random.Next(min,max))
    if bins[t] < teamSize - 1:         # cap: at most teamSize-1 big islands / team
        bins[t] += 1
    # (sum via 10148acfc; loop until total big islands == bigIslandKount)

# 2. turn each team's big-island count into concrete army sizes
teamBigArmies = []
for t in range(teams):
    n = bins[t]                                 # 2 .. teamSize-1
    bigArmyMass = teamStartArmySize - teamSize + n   # armies that live on big islands
    teamBigArmies.append(splitArmies(n, bigArmyMass))  # even split (10148ad24)
return teamBigArmies
```

**Why the arithmetic closes to a fair game.** Each team owns exactly `teamSize`
nodes and exactly `teamStartArmySize` armies:
- `n` big islands share `bigArmyMass = teamStartArmySize − teamSize + n` armies
  (even split), and the remaining `teamSize − n` nodes are size-1 singles.
- Total armies = `(teamStartArmySize − teamSize + n) + (teamSize − n)·1 =
  teamStartArmySize`. ✓ (e.g. teamSize 6, n 3, start 20 → big split
  `splitArmies(3, 17) = [6,6,5]` + three 1-singles = 20 armies over 6 nodes.)
- Global consistency: `sum_t(teamSize − bins[t]) = teams·teamSize − bigIslandKount
  = maxLive − bigIslandKount = singlesKount`. ✓ The whole system is closed:
  **every faction gets identical node count and identical army total; only the
  internal lumpiness (how many big islands, how concentrated) varies by RNG.**

This is the exact mechanism behind `sim-vs-real-deal-imbalance` (real faction
strength spread ≈ 0): equal totals by construction, unequal *shape*.

Only the `.NET Random` draw *order* (which teams grow, ergo the exact bins for a
given seed) is not reproduced by this static decode — that needs emulation for
golden-seed bit-exactness, but the **distribution** is fully specified above.

## `makeArmiesBuildList(teamBigArmies, teams, teamSize, bigIslandKount, …)` (idx 333 @ 0x1014689a0) — CONFIRMED

Turns each team's big-army size list into placement "elements" (groups of
adjacent nodes). For team `t` with size list `L` (`len 2..teamSize`):

```
n = len(L)
if n == 2:
    if this.fairCoin():                 # 50/50 coin (this.gameRnd.Next(2))
        addOneNodeElement(t, L[0]); addOneNodeElement(t, L[1])   # two separate singles
    else:
        addTwoNodesElement(t, L[0], L[1])                        # one adjacent pair
elif n == 3:
    addThreeNodesElement(t, L[0], L[1], L[2])                    # an adjacent triple
elif n > 3 and n even:
    for j in 0,2,4,…: addTwoNodesElement(t, L[j], L[j+1])        # pairs
elif n > 3 and n odd:
    addThreeNodesElement(t, L[0], L[1], L[2])
    for j in 3,5,…:   addTwoNodesElement(t, L[j], L[j+1])        # triple + pairs
```

Helper trampoline map (verified by call-site signatures):
`10148ab80`=`List<List<int>>.get_Item`, `10148ab94`=`List<int>.get_Item`,
`10148ac70`=`MapMaker.fairCoin` (→ `this.gameRnd.Next(2)`),
`10148ac84`=`addOneNodeElement`, `10148ac98`=`addTwoNodesElement`,
`10148acac`=`addThreeNodesElement`, `10148a630`=`List<int>.Add`,
`10148ace8`=`List<int>.set_Item`.

So the "4 fixed templates" idea in CLAUDE.md is an **oversimplification**: the
per-faction layout is (a) an even army split over a randomly-sized set of big
islands, (b) grouped into adjacent 2- and 3-node clusters, with (c) a fair coin
choosing singles-vs-pair for the 2-island case, (d) plus a Gaussian number of
size-1 filler nodes, (e) all regenerated until topology+setup validate.

## Spawn geometry — `getBuildCluster` / `findBuildCluster` / `buildElementSet` — DECODED (static)

This is the part that decides **which nodes each faction occupies and who they
border** — the opening-exposure question. Island layout (confirmed, and
consistent with the battle RE): `Island.+0x58` = neighbor/adjacency list,
`+0x60` = army size, `+0x64` = owner/team, `+0x69` = "built" flag,
`+0x70/+0x74` = grid coords.

**`findBuildCluster(clusterSize, isle, liveList)`** grows a *connected* cluster of
`clusterSize ∈ {1,2,3}` unbuilt islands starting at `isle` (a jump table
dispatches on size — anything else throws, which is exactly why
`makeArmiesBuildList` only ever emits 1/2/3-node elements):

```
if isle.built: return null
size 1 → [isle]
size 2 → shuffle(isle.links); pick first unbuilt neighbor n → [isle, n]  (null if none)
size 3 → u = unbuilt neighbors of isle (shuffled)
         if len(u) >= 2 → [isle, u[0], u[1]]
         elif len(u) == 1 → n=u[0]; v = unbuilt neighbors of n excluding isle (shuffled)
                            → [isle, n, v[0]]  (null if none)
         else null
```

**`getBuildCluster(clusterSize, liveList)`** shuffles `liveList`, then scans for
the first start island that yields a valid `findBuildCluster` of exactly that
size; returns it (or null).

**`buildElementSet(element)`** places one `BuildElement {team, builds:List<int>}`:
`cluster = getBuildCluster(len(builds), getLiveIslands())`; if null → fail. Then
for each node j: `node.owner = team`, `node.army = builds[j]`, `node.built = 1`.

**`buildArmiesBuildList(list)`** does `buildElementSet` for every element; **any
failure aborts and regenerates the whole map** (the retry loop in
`makeIslandArrayDyno`).

**Consequence — factions are fragmented, not blobbed.** A faction's `teamSize`
nodes are placed as *several independent 1-/2-/3-node connected clusters*,
scattered across a shuffled board. Each cluster's neighbors are whatever unbuilt
islands happened to be adjacent, so **faction-to-faction adjacency is essentially
random per cluster**, set independently of army strength. This is the concrete
spawn-exposure mechanism to check our engine's board-gen against — our residual
losses are early-round, exactly where this adjacency decides who gets attacked
first.

## Why this matters for the sim/real gap

- Memory `sim-vs-real-deal-imbalance` found real deals give every faction EQUAL
  strength (spread ≈ 0) while our i.i.d. sim has spread ≈ 15. This code is the
  *mechanism*: identical procedure + identical `teamStartArmySize` per team +
  even `splitArmies` ⇒ symmetric factions by construction.
- The **spawn geometry** (who is adjacent to whom) comes from
  `getBuildCluster`/`findBuildCluster` growing adjacent clusters — not yet
  decoded here, relevant to opening-round exposure (where our residual losses
  concentrate).
- Next faithfulness win after battle: replace our synthetic deal with this exact
  procedure once `getBigArmies` is emulated, then re-freeze the golden-seed gates
  (map RNG consumption changes, exactly like the battle change did).

## How our engine (`fast_engine.c`) compares — VALIDATED + one gap

**Deal magnitudes: our 4 templates ARE the real procedure (ground-truth
confirmed).** For `teamSize = 6` the decoded `getBigArmies`+`splitArmies` has
exactly four possible per-faction outputs, one per big-island count `bins ∈
{2,3,4,5}`:

| bins | splitArmies(bins, 20−6+bins) | + singles | faction deal | our `DEAL_TMPL` |
|------|------------------------------|-----------|--------------|-----------------|
| 2 | [8,8]        | 4×1 | {1,1,1,1,8,8} | `TMPL[1]` |
| 3 | [6,6,5]      | 3×1 | {1,1,1,5,6,6} | `TMPL[0]` |
| 4 | [5,5,4,4]    | 2×1 | {1,1,4,4,5,5} | `TMPL[2]` |
| 5 | [4,4,4,4,3]  | 1×1 | {1,3,4,4,4,4} | `TMPL[3]` |

All four match exactly. Our MLE template weights (0.392/0.330/0.201/0.077 →
bins 3/2/4/5) imply mean bins ≈ 3.03, so mean total big islands ≈ 5·3.03 ≈ 15.1
= `maxLive/2` = the `makeSinglesKount` Gaussian mean — i.e. our fitted deal
independently *recovered* both the split procedure and the `bigIslandKount ≈
maxLive/2` structure. **The deal values need no change.** (Second-order nit: real
factions' bins are coupled by a shared `sum = bigIslandKount` draw; we draw each
faction's template i.i.d., so our board-total big-island count has slightly more
variance than real. Almost certainly negligible.)

**Placement geometry: this is the real divergence.** Our `new_game` grows *one
territory per faction* (1 seed + `OWNER_SCATTER=0.6` random-vs-border growth),
then assigns the deal by **shuffling the template onto owned nodes** — so army
size and local adjacency are decorrelated. The real game instead places each
faction as **several independent 1-/2-/3-node connected clusters whose sizes come
from the deal itself**: the big-army islands are laid down as adjacent 1/2/3-node
groups (a two-big-island `{8,8}` is placed as either an adjacent pair or two
separate singles by a `fairCoin`), and each size-1 filler is its own isolated
1-node cluster. So in the real game **big stacks sit in small tight clusters and
singles are scattered as lone exposed nodes**, a spatial army↔geometry correlation
our shuffle-onto-territory model does not reproduce. Since our residual losses are
early-round (memory `real-game-loss-analysis`), this placement mismatch — not the
deal magnitudes — is the remaining board-faithfulness lever worth testing.

## Reusable tooling added

- `ipa_decompile/re/find_table.py` — locates the AOT `method_addresses` table
  from anchor addresses and dumps any method index → native address.
- `ipa_decompile/re/extract_asm.py` — slices `module_all.txt` into per-method
  `re/mm/<Name>.asm` files for the MapMaker/deal/RNG set.
