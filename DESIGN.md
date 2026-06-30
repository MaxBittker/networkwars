# Network Wars — Design Doc

A faithful, minimal reproduction of Jim Rutt's **Network Wars**. All rules live in one C
implementation (`solver/fast_engine.c`); the browser frontend runs that engine in-process
as WASM, and a Python ctypes client drives it headlessly. The same game can be driven by a
human (via the web UI) or by a program (bot / search).

> This doc is the single source of truth for the rules. If any rule below is wrong, tell me
> and I'll fix it here first, then in the code. The original game's exact rules aren't
> published; the battle model and deal here were **fit to thousands of live iOS battles**
> (see `solver/BATTLE_FUNCTION.md` / `solver/IOS_CALIBRATION.md`). Remaining guesses are
> marked **[ASSUMPTION]**.

---

## 1. Factions

- 5 factions: **RED, GREEN, YELLOW, BLUE, PURPLE**.
- RED is the human player. GREEN/YELLOW/BLUE/PURPLE are AI bots.
- Colors match the source game (red, green, gold/yellow, blue, purple).

## 2. The Network (board)

- A graph of **Nodes** connected by **Links**.
- Each node has an `owner` (faction) and a `strength` (army size, integer ≥ 1 while owned).
- Links are undirected. Two nodes can attack each other only if a link connects them.
- Board is **30 nodes, 6 per faction** (confirmed from the real app: a 6×7 grid of 42 cells
  with 12 removed = 30). Win condition is 24 nodes.
- **The deal** (calibrated to the real app, `IOS_CALIBRATION.md` §2): each faction's 6 nodes
  are one of **4 fixed templates** that each sum to **20** total strength, so every faction
  starts perfectly balanced (board total always 100). Templates and frequencies: `[1,1,1,5,6,6]`
  38.5%, `[1,1,1,1,8,8]` 32.7%, `[1,1,4,4,5,5]` 22.2%, `[1,3,4,4,4,4]` 6.6%. (Strengths reach 8;
  there are no 7s.)
- **[ASSUMPTION]** Layout: nodes are placed on a diamond/triangular lattice (offset rows,
  diagonal links) to mimic the look of the screenshots. The generator is procedural and
  seedable; the precise topology of the original isn't published, so we approximate it with
  a connected, planar-ish mesh.

## 3. Turn order

1. RED (human) takes a turn: attack 0+ times, then **End Turn**.
2. Each bot faction takes a turn in fixed order: GREEN, YELLOW, BLUE, PURPLE.
3. After **each** faction's turn (including RED), that faction receives **reinforcements**.
4. Repeat until someone holds 24 nodes or only one faction remains.

## 4. Attacking

- You may attack from any node you own with **strength > 1**, along a link, into an enemy
  node. A node with strength 1 cannot attack.
- One attack action resolves a **single decisive battle** (this is what the real app does, fit
  from ~9,400 live battles — see `BATTLE_FUNCTION.md`). Let `a` = attacker strength, `d` =
  defender strength:
  - **Who wins** is one Bernoulli draw: `P(capture) = a^3.40 / (a^3.40 + 1.26·d^3.40)`. The
    power-of-~3.4 ratio makes strength far more decisive than a coin flip (2:1 ≈ 90%, equal ≈
    47%).
  - **On capture** the attacker takes the node and the **source node always drops to 1**. The
    captured node's new strength (the occupier) is a draw around the fitted mean
    `clip(0.82a − 0.44d + 0.10, 1, a−1)` — specifically `1 + BetaBinomial(a−2, …)` (one
    overdispersion param, ρ=0.21).
  - **On repel** the source node still drops to 1; the **defender is gutted** to a draw around
    `clip(0.30 + 0.24d + 0.42·max(0, d−a), 0, d)` — `Binomial(d, …)`. (Capture requires a
    surviving occupier; a fully-spent attacker does **not** flip ownership.)
- A turn can contain any number of attacks.

## 5. Reinforcements

Applied to a faction at the end of that faction's turn:

1. Find that faction's **connected components** (groups of its own nodes joined by links).
2. Take the **largest** component (by node count). Let its size be `N`.
3. Identify the component's **border nodes**: nodes in it adjacent to at least one enemy node.
4. Add `N` total strength, distributed **evenly** across those border nodes; any remainder is
   handed out one-at-a-time, round-robin. **[ASSUMPTION]** Round-robin order is by node id
   (deterministic). Only the single largest component is reinforced; other components get none.
5. If the largest component has no border nodes (fully surrounded by own/edge), no
   reinforcement is placed. **[ASSUMPTION]**

## 6. Win / loss

- Any faction reaching **24 owned nodes wins immediately** (checked after every capture and
  every turn). For RED that's "You Won!"; otherwise "You Lost."
- A faction with 0 nodes is eliminated and skips its turns.
- **Surrender**: RED can surrender, ending the game as a loss.

## 7. Bot AI (deterministic, transparent — this is the heart of the game)

On a bot's turn, repeatedly (this ordering was matched to the observed real iOS bot):

- Pick the bot's **strongest own node** with strength > 1 that has a beatable enemy neighbor
  (attacker strength **>** the neighbor's strength).
- From that node, attack its **weakest reachable enemy target**.
- **Ties are broken at random** (per-game seeded RNG, so outcomes stay reproducible) — this
  matches the real app better than the old deterministic id-order tie-break.
- Repeat until no owned node is stronger than a reachable enemy. Then end turn (reinforcements
  apply).
- Bots only attack when strictly stronger, so they never start a fight they aren't favored to
  win — matching "attack whenever a node is stronger than a neighboring enemy."

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
| POST `/api/game/:id/surrender` | —                 | End game as RED loss |

State payload: `{ id, nodes:[{id,x,y,owner,strength}], links:[[a,b]], counts:{red,...},
turn, phase, winner, log:[...], legalMoves:[{from,to}] }`. `legalMoves` lets a UI or API
client know exactly what RED can do without re-deriving rules.

### Determinism / testing

RNG is seeded per game. A headless script can: create a game with a fixed seed, read
`legalMoves`, post attacks, end turns, and assert outcomes — same path the UI uses.
