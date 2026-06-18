# Network Wars — Design Doc

A faithful, minimal reproduction of Jim Rutt's **Network Wars** as a server + thin web
frontend. The server owns all game state and rules; the frontend only renders state and
sends player actions. The same HTTP API can be driven by a human (via the web UI) or by a
program (bot / script).

> This doc is the single source of truth for the rules. If any rule below is wrong, tell me
> and I'll fix it here first, then in the code. Assumptions I had to make are marked
> **[ASSUMPTION]** — these are the most likely things to want tweaking.

---

## 1. Factions

- 5 factions: **RED, GREEN, YELLOW, BLUE, PURPLE**.
- RED is the human player. GREEN/YELLOW/BLUE/PURPLE are AI bots.
- Colors match the source game (red, green, gold/yellow, blue, purple).

## 2. The Network (board)

- A graph of **Nodes** connected by **Links**.
- Each node has an `owner` (faction) and a `strength` (army size, integer ≥ 1 while owned).
- Links are undirected. Two nodes can attack each other only if a link connects them.
- **[ASSUMPTION]** Board starts with **30 nodes**, **6 per faction** (the 2:32 screenshot
  shows a 6/6/6/6/6 opening). Win condition is 24 nodes, so total must exceed 24.
- **[ASSUMPTION]** Layout: nodes are placed on a diamond/triangular lattice (offset rows,
  diagonal links) to mimic the look of the screenshots. Exact generator is procedural and
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
- One attack action resolves a **full battle** between the two nodes (not a single coin flip):
  - Model each side's strength as a stack of units.
  - Repeat: flip a biased coin. On an attacker win, the **defender** loses 1 unit; on a
    defender win, the **attacker** loses 1 unit.
  - The battle ends when either:
    - **Defender reaches 0** → attacker **captures** the node. The attacker leaves 1 unit
      behind and moves the rest in: captured node strength = (attacker's current strength − 1),
      attacker node strength = 1.
    - **Attacker reaches 1** → attacker can no longer fight; battle stops. Attacker stays at
      1, defender keeps whatever it has left (no ownership change).
- **[ASSUMPTION]** Attacker coin-win probability = **0.55** ("a slight advantage for the
  attacker"). Configurable server-side.
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

On a bot's turn, repeatedly:

- Consider every owned node with strength > 1 that has an adjacent enemy node it can beat
  (attacker strength **>** that neighbor's strength).
- The bot **attacks the weakest beatable enemy** it can reach.
- **[ASSUMPTION]** Tie-breaks (equal-strength targets, multiple attackers): choose the
  attack with the largest attacker strength first, then lowest target node id — fully
  deterministic so a human can predict bots (the blog calls this out as intended).
- Repeat until no node has strength > a beatable neighbor. Then end turn (reinforcements apply).
- Bots only attack when strictly stronger, so they never start a coin-flip they can't be
  favored to win on the first exchange — matching "attack whenever a node is stronger than a
  neighboring enemy."

## 8. Architecture

- **Server**: Node.js, standard library only (no build step, no deps). In-memory games keyed
  by `gameId`. Seedable RNG for reproducible games/tests.
- **Frontend**: single static `index.html` + vanilla JS canvas/SVG render. Thin: it only
  draws server state and posts actions. No game logic client-side.

### HTTP API

| Method | Path                       | Body                  | Effect |
|--------|----------------------------|-----------------------|--------|
| POST   | `/api/game`                | `{seed?}`             | New game, returns full state |
| GET    | `/api/game/:id`            | —                     | Current state |
| POST   | `/api/game/:id/attack`     | `{from, to}`          | Resolve one battle (RED's turn only) |
| POST   | `/api/game/:id/end-turn`   | —                     | Run all bot turns + reinforcements |
| POST   | `/api/game/:id/surrender`  | —                     | End game as RED loss |

State payload: `{ id, nodes:[{id,x,y,owner,strength}], links:[[a,b]], counts:{red,...},
turn, phase, winner, log:[...], legalMoves:[{from,to}] }`. `legalMoves` lets a UI or API
client know exactly what RED can do without re-deriving rules.

### Determinism / testing

RNG is seeded per game. A headless script can: create a game with a fixed seed, read
`legalMoves`, post attacks, end turns, and assert outcomes — same path the UI uses.
