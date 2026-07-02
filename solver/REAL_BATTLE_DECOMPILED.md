# The REAL battle function — decompiled from the shipped iOS app (2026-07-02)

We got the actual `networkwars.ipa` and decompiled it. This is no longer a
statistical guess: this is the game's own source logic, recovered from the
binary. **The battle is iterated fair-coin attrition. There are no fitted
parameters and no separate survivor distribution.**

## Provenance / how it was recovered

- The app is a **Xamarin / Mono .NET** app. The game logic lives in the managed
  assembly `NetworkWars.Standard.dll` (namespace `UtilsDLL`). `ilspycmd`
  recovers the full class/method structure, but the IL bodies were **stripped**
  (Xamarin AOT) — every method is a bare `ret`. The real code is AOT-compiled to
  **ARM64** inside the 28 MB `NetworkWars.iOS` Mach-O.
- Method bodies were located by parsing the Mono AOT `MonoAotFileInfo` for
  `NetworkWars.Standard` (found via its `assembly_name` string), reading
  `jit_code_start`/`method_addresses` (a table of `bl <method>` branch
  instructions), and mapping metadata tokens → native addresses. Key functions:
  - `Utils.symBattle` (idx 268) → `0x1014614b0`
  - `Utils.doAttack` (idx 257) → `0x10145fdc0` (the interactive path the game/bots use)
  - `Utils.doAttackConsole` (idx 258) → `0x1014604e0` (headless/sim path)
  - `Utils.killflip` (idx 259) → `0x1014606c0`
  - `GameRandoms.GetFlip` (idx 354) → `0x10146b4e0`
- The recovered ARM64 was **executed under Unicorn** (real code, fake Island
  structs, the coin stubbed) and a pure-Python reimplementation was checked
  **bit-exact** against it over 3,000 random battles (captured / survivors /
  owner / even the flip count all match). `doAttack` and `doAttackConsole` share
  the identical battle loop.

Tooling lives under `ipa_decompile/` (decompiled C#, `re/emu_battle.py`,
`re/validate_model.py`, `re/dp.py`).

## The mechanic

Every faction owns its own seeded `System.Random` (`GameRandoms.TeamRndObjs`).
The atomic operation is a **fair coin**:

```
killflip(team)  ==  GameRandoms.GetFlip(team)  ==  teamRandom.Next(2)   // 0 or 1, p = 0.5
```

`GetFlip` also records each result into `FlipData {Team, Count}` — that is purely
for **save-game reproducibility**, not bias. The coin is genuinely 50/50.

The battle passes each node's **owner** (Island field `+0x64`) to the coin — never
the army size. Army sizes (`+0x60`) only drive the loop counters. So there is **no
power-ratio, no strength curve, no dice-sum** — just fair coins and counting.

## The battle loop (ground truth from `doAttackConsole`)

`a` = attacker army, `d` = defender army. Attacker must have `a > 1` to attack.

```
battle(a, d):
    # two guarded "attacker pre-fires" (compiler-peeled; real and load-bearing):
    if d > 0 and a > 1 and coin():  d -= 1
    if d > 0 and a > 1 and coin():  d -= 1
    # symmetric exchange, both sides fire every round:
    while d > 0 and a > 1:
        if coin():  d -= 1        # attacker's coin -> defender loses one
        if coin():  a -= 1        # defender's coin -> attacker loses one
    # outcome:
    if a > 1 and d == 0:          # CAPTURE
        defender.owner = attacker.owner
        defender.army  = a - 1    # survivors move in
        attacker.army  = 1        # source ALWAYS keeps exactly 1
    else:                         # REPEL (attacker ground down to 1)
        attacker.army  = 1
        defender.army  = d        # whatever defenders remain
```

Notes that matter:

- **Two attacker pre-fires.** Before the defender ever shoots back, the attacker
  takes up to two free swings. This is a real, small attacker edge baked into the
  binary (a compiler-peeled loop prologue, verified by emulation — not an
  artifact).
- **Survivors are NOT a separate draw.** The occupier count is exactly *whatever
  attackers survived the coin war, minus one*. Our shipped engine models
  survivors with a fitted (beta-)binomial; the real game has no such thing — the
  attrition loop *is* the survivor distribution. The mean happens to look like our
  fitted curve, but the real spread is the emergent random-walk spread.
- **Source always keeps 1**, occupier moves in with `a-1`. (We had this right.)
- **Double-KO edge case:** if the last round drops `d` to 0 and `a` to 1 in the
  same round, `a > 1` fails → it's a **repel**, and the defender node is left with
  0 armies. Rare but faithful.

## P(capture) — exact (DP, matches Monte Carlo)

rows = attacker army, cols = defender army:

```
A\D     1     2     3     4     5     6     8    10    12    16    20
  2  .833  .444  .148  .049  .016  .005  .001  .000  .000  .000  .000
  3  .944  .741  .444  .214  .093  .038  .006  .001  .000  .000  .000
  4  .981  .889  .691  .450  .252  .128  .027  .005  .001  .000  .000
  5  .994  .955  .845  .662  .455  .278  .081  .019  .004  .000  .000
  6  .998  .982  .927  .811  .643  .459  .178  .053  .013  .001  .000
  8 1.000  .997  .986  .952  .880  .765  .464  .213  .077  .006  .000
 10 1.000 1.000  .998  .990  .968  .921  .734  .468  .238  .035  .003
 12 1.000 1.000 1.000  .998  .993  .978  .895  .711  .471  .119  .016
 16 1.000 1.000 1.000 1.000 1.000  .999  .990  .951  .851  .475  .151
 20 1.000 1.000 1.000 1.000 1.000 1.000  .999  .995  .977  .819  .478
```

Exact main-loop recurrence (`C` = capture prob before a loop iteration):

```
C(a,0)   = 1 if a>1 else 0
C(1,d)   = 0            (d>0)
C(a,d)   = [ C(a-1,d-1) + C(a,d-1) + C(a-1,d) ] / 3     (a>1, d>0)
```
(The three equal-weight branches come from conditioning the two coins on
*at-least-one hit*; the no-hit case just repeats the state.) Then average `C(a,·)`
over the two pre-fire outcomes on `d`.

**At parity** `P(capture)` rises from **0.444** (2v2) toward **0.5** (20v20) —
the attacker is slightly *below* even at small stacks because it must retain ≥2 to
win (effectively `a-1` lives vs `d`), and the two pre-fires only partly offset
that. This size-dependence is real and is something our old fixed-ratio
`a^3.40/(a^3.40+1.26 d^3.40)` model could not represent (it pins parity at 0.442
for all sizes).

## How this compares to what we shipped

- Our fitted single-shot `P(capture)=a^G/(a^G+C·d^G)` (G=3.40, C=1.26) is,
  pleasantly, a **very good approximation** — it nails parity (0.442 ≈ 0.444) and
  is close across the grid. The ~77→94% sim/real reconciliation work was not
  wasted; we were fitting a good surrogate.
- The **real win** here is (a) removing all fitted parameters, (b) the correct
  size-dependence at parity, (c) survivors that are exactly right by construction
  instead of a fitted beta-binomial, and (d) the two-pre-fire attacker edge.

## What changes in the engine

`resolve_battle` becomes the loop above (fair `RNG() < 0.5` coins — integer-clean,
WASM-parity-safe). `resolve_battle_logged` can now emit the **true** per-round
flip sequence for the browser animation instead of a synthesized one. The
search's capture-probability / expected-occupier heuristic tables are recomputed
from the exact DP above. Golden-seed gates must be re-frozen (the RNG consumption
per battle changed).
