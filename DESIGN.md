# Network Wars — Design Doc

A faithful, minimal reproduction of Jim Rutt's **Network Wars**. All rules live in one C
implementation (`solver/fast_engine.c`); the browser frontend runs that engine in-process
as WASM, and a Python ctypes client drives it headlessly. The same game can be driven by a
human (via the web UI) or by a program (bot / search).

> This doc is the single source of truth for the rules. If any rule below is wrong, tell me
> and I'll fix it here first, then in the code. Battle mechanics and army grouping
> were recovered from the shipped iOS app's Mono-AOT ARM64 code. Random map/deal
> distributions and ordering are still approximations; see `solver/RULES_AUDIT.md`.

---

## 1. Factions

- 5 factions: **RED, GREEN, YELLOW, BLUE, PURPLE**.
- RED is the human player. GREEN/YELLOW/BLUE/PURPLE are AI bots.
- Colors match the source game (red, green, gold/yellow, blue, purple).

## 2. The Network (board)

- A graph of **Nodes** connected by **Links**.
- Each node has an `owner` (faction) and a `strength` (army size, integer ≥ 0).
  Simultaneous final casualties can leave an owned defender with zero armies.
- Links are undirected. Two nodes can attack each other only if a link connects them.
- Board is **30 nodes, 6 per faction** (confirmed from the real app: a 6×7 grid of 42 cells
  with 12 removed = 30). Win condition is 24 nodes.
- **The deal** (recovered from the real app, `MAP_DEAL_DECOMPILED.md`): each faction's 6 nodes
  are one of **4 fixed templates** that each sum to **20** total strength, so every faction
  starts perfectly balanced (board total always 100). Templates and frequencies: `[1,1,1,5,6,6]`
  39.2%, `[1,1,1,1,8,8]` 33.0%, `[1,1,4,4,5,5]` 20.1%, `[1,3,4,4,4,4]` 7.7%. These are our
  fitted sampling weights, not exact original probabilities. (Strengths reach 8;
  there are no 7s.)
- Large armies are placed as connected groups: the two 8s may be separate or adjacent;
  `[6,6,5]` is a connected triple; `[5,5,4,4]` forms two pairs; `[4,4,4,4,3]` forms
  a `[4,4,4]` triple and a `[4,3]` pair. One-army fillers occupy remaining nodes.
  Groups may touch and merge; fillers are not required to be isolated from teammates.
- Topology uses horizontal, vertical and diagonal adjacency on a 6×7 grid, with 30 live
  cells and a connected graph. **[APPROXIMATION]** Our connectivity-preserving removal
  sampler differs from the original's topology rejection sampler. Army-template counts
  are sampled independently; the original couples them through a shared singles count.

## 3. Turn order

1. RED (human) takes a turn: attack 0+ times, then **End Turn**.
2. Each bot faction takes a turn in fixed order: GREEN, YELLOW, BLUE, PURPLE.
3. After **each** faction's turn (including RED), that faction receives **reinforcements**.
4. Repeat until someone holds 24 nodes or only one faction remains.

## 4. Attacking

- You may attack from any node you own with **strength > 1**, along a link, into an enemy
  node. A node with strength 1 cannot attack.
- One attack action resolves a full **battle** via the game's own mechanic — recovered
  bit-exact from the shipped app (see `REAL_BATTLE_DECOMPILED.md`). It is **iterated
  fair-coin attrition** with **zero fitted parameters**. Let `a` = attacker strength,
  `d` = defender strength:
  - The atomic operation is a **fair coin** (p = 0.5). First, two guarded attacker
    **pre-fires**: each, if `d > 0` and `a > 1`, flips a coin that may drop the defender by 1.
  - Then a **symmetric loop** runs while `d > 0` and `a > 1`: each round the attacker's coin
    can drop one defender and the defender's coin can drop one attacker.
  - **Capture** iff the loop ends with `a > 1` and `d == 0`: the attacker takes the node, the
    occupier is exactly the **surviving `a − 1`**, and the **source node drops to 1**.
  - **Repel** otherwise: the **source node drops to 1** and the defender keeps its surviving
    remnant `d`. (A fully-spent attacker does **not** flip ownership.)
  - Survivors are **emergent** — the attrition loop *is* the survivor distribution; there is no
    separate draw. Because strength is decisive but not deterministic, the attacker's edge grows
    with the ratio (2:1 ≈ 90%, equal ≈ 47%) as a *consequence* of the loop, not a fitted curve.
    Coins are integer `RNG() < 0.5` so native and WASM stay bit-identical.
- A turn can contain any number of attacks.

## 5. Reinforcements

Applied to a faction at the end of that faction's turn:

1. Find that faction's **connected components** (groups of its own nodes joined by links).
2. Take the **largest** component (by node count). Let its size be `N`.
3. Identify the component's **border nodes**: nodes in it adjacent to at least one enemy node.
4. Add `N` total strength, distributed **evenly** across those border nodes; any remainder is
   handed out one-at-a-time, round-robin. **[ASSUMPTION]** Round-robin order is by node id
   (deterministic). Only the single largest component is reinforced; other components get none.
5. If the largest component has no border nodes, pass the same `N`-army budget to the
   next-largest component with a border. If none has a border, place nothing. This
   fallback matters only for disconnected imported boards; in a connected unfinished
   game every owned component has an enemy border. The original shuffles ties and
   border order; our deterministic ordering is retained.

## 6. Win / loss

- Any faction reaching **24 owned nodes wins immediately** (checked after every capture and
  every turn). For RED that's "You Won!"; otherwise "You Lost."
- A faction with 0 nodes is eliminated and skips its turns. RED at 0 nodes ends the
  game immediately as a loss (a wiped red can never move again).
- Finished games accept no further attacks or turns. Illegal attack requests leave
  the board and dice untouched, including attacks across missing links or from enemies.

## 7. Bot AI (decompiled — the real `OpponentAIOriginal` from the shipped app)

Recovered from the IPA (see `solver/REAL_BOT_DECOMPILED.md`); exact tie ordering remains
an approximation. On a bot's turn it
makes **one strongest-first pass** over the nodes it owned at the start of the turn:

- Iterate the bot's own nodes in **descending strength** order (snapshot taken before the
  first attack — nodes captured mid-turn are never iterated directly).
- Each node attacks its **smallest adjacent enemy**, but only when favored:
  `okAttack(a, d)` = attacker strength ≥ 2 **and** strictly > defender strength.
- On a **capture**, the bot **keeps attacking with the stack it just moved** (a chain),
  repeating smallest-adjacent-enemy + okAttack until a repel or no strictly-weaker target.
- A stack is never revisited, and attacks that open up later in the turn are not taken.
- **No RNG in move selection** — ties are deterministic (node-id / adjacency order); bot
  turns consume dice only inside battles. Then end turn (reinforcements apply).

Starting with rules version 2, new games use recovered army grouping. Saved rounds
without a version use the version 1 generator for resume, review, and inspection;
their boards and dice are preserved. The version is stored with each new round.

## 8. Architecture

- **Engine**: a single C implementation (`solver/fast_engine.c`) of all rules + board
  generation + the C-UCT search. This is the source of truth; there is no separate JS
  rules engine. It is compiled two ways: natively (`fast_engine.so`, driven by Python
  ctypes via `fastnw.py`) and to **WASM** (`public/fast_engine.js`).
- **Browser frontend**: `public/` is self-contained. The WASM engine + search run in a Web
  Worker (`engine.worker.js`, which holds game state and speaks the `/api/game/*` contract
  over postMessage); `index.html` is just canvas rendering and input. **No backend needed**
  — serve `public/` statically. Seeded mulberry32 per game for reproducibility.
- **Server (optional)**: `solver/server.py` — stdlib `http.server`, drives the native engine
  via ctypes. Only used for the live iOS `/grab` workflow; the browser game does not need it.

### Game API (postMessage in the browser; HTTP on the optional server)

| Path                       | Body                  | Effect |
|----------------------------|-----------------------|--------|
| POST `/api/game`           | `{seed?}`             | New game, returns full state |
| GET  `/api/game/:id`       | —                     | Current state |
| POST `/api/game/:id/attack`| `{from, to}`          | Resolve one battle (RED's turn only) |
| POST `/api/game/:id/end-turn` | —                  | Run all bot turns + reinforcements |
| POST `/api/game/:id/search`| `{sims?, maxSims?, grade?, ...}` | C-UCT search from the current position; returns ranked root moves + win% |
| POST `/api/game/:id/sweep-check` | `{trials?, maxLosses?}` | Monte-Carlo certificate of the mop-up policy (sweep-up offer gate) |

State payload: `{ id, nodes:[{id,x,y,owner,strength}], links:[[a,b]], counts:{red,...},
turn, phase, winner, log:[...], legalMoves:[{from,to}] }`. `legalMoves` lets a UI or API
client know exactly what RED can do without re-deriving rules.

### Determinism / testing

RNG is seeded per game. A headless script can: create a game with a fixed seed, read
`legalMoves`, post attacks, end turns, and assert outcomes — same path the UI uses.
