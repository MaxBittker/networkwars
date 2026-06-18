'use strict';
// ---------------------------------------------------------------------------
// Network Wars — policy simulation harness.
//
// A "policy" is a function that plays RED's turn:
//
//     function policy(api) { ...call api.attack(from, to) as many times as you like... }
//
// The `api` handed to your policy each turn exposes a read view of the board and
// a single mutating action (attack). When your function returns, RED's turn ends:
// the engine applies RED's reinforcements, then runs all four bots, then it's your
// turn again. The harness loops until someone wins (24 nodes) or only one faction
// is left.
//
//   api.faction            -> 'red'
//   api.nodes              -> [{id, x, y, owner, strength}]  (live; re-read each call)
//   api.node(id)           -> a single node
//   api.counts()           -> {red, green, yellow, blue, purple}  node counts
//   api.neighbors(id)      -> [nodeId, ...]
//   api.legalMoves()       -> [{from, to}]  every attack RED may currently make
//   api.attack(from, to)   -> {captured, fromStrength, toStrength, ...}  (resolves a full battle)
//   api.rng()              -> seeded [0,1) random, reproducible per game
//
// Run `node sim.js` to benchmark the sample policies below over 100 games each.
// ---------------------------------------------------------------------------

const G = require('./game');

const MAX_ATTACKS_PER_TURN = 1000; // runaway guard for buggy policies
const MAX_TURNS = 300;             // a game this long is treated as a draw/loss

function makeGame(seed) {
  const rng = G.makeRng(seed >>> 0);
  const board = G.buildBoard(rng);
  return { ...board, rng, policyRng: G.makeRng((seed ^ 0x9e3779b9) >>> 0) };
}

// The per-turn API object handed to a policy.
function turnApi(state, faction) {
  let attacks = 0;
  return {
    faction,
    get nodes() { return state.nodes; },
    node: (id) => state.nodes[id],
    counts: () => G.counts(state),
    neighbors: (id) => state.adj[id],
    legalMoves: () => G.legalMoves(state, faction),
    rng: state.policyRng,
    attack(from, to) {
      if (attacks++ >= MAX_ATTACKS_PER_TURN) throw new Error('attack budget exceeded');
      const f = state.nodes[from], t = state.nodes[to];
      if (!f || !t) throw new Error('bad node id');
      if (f.owner !== faction) throw new Error('not your node');
      if (f.strength <= 1) throw new Error('node too weak');
      if (t.owner === faction) throw new Error('own node');
      if (!state.adj[from].includes(to)) throw new Error('nodes not linked');
      return G.resolveBattle(state, from, to);
    },
  };
}

// Play one full game with `policy` as RED. Returns the result record.
function playGame(policy, seed) {
  const state = makeGame(seed);
  let turns = 0;
  while (!G.checkWinner(state) && turns < MAX_TURNS) {
    turns++;
    try { policy(turnApi(state, G.HUMAN)); }
    catch (_) { /* policy threw -> just end RED's turn */ }
    if (G.checkWinner(state)) break;
    G.reinforce(state, G.HUMAN);
    if (G.checkWinner(state)) break;
    const log = [];
    for (const bot of G.BOTS) {
      G.runBotTurn(state, bot, log);
      if (G.checkWinner(state)) break;
    }
  }
  const winner = G.checkWinner(state);
  return { seed, winner, won: winner === G.HUMAN, turns, counts: G.counts(state) };
}

// Score a policy over `games` games (seeds seedBase .. seedBase+games-1).
function scorePolicy(policy, { games = 100, seedBase = 1 } = {}) {
  const t0 = process.hrtime.bigint();
  let wins = 0, winTurns = 0, totalTurns = 0;
  for (let i = 0; i < games; i++) {
    const r = playGame(policy, seedBase + i);
    totalTurns += r.turns;
    if (r.won) { wins++; winTurns += r.turns; }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    games,
    wins,
    winRate: wins / games,
    avgTurnsToWin: wins ? winTurns / wins : null,
    avgGameLength: totalTurns / games,
    totalMs: ms,
    msPerGame: ms / games,
  };
}

// --- sample policies --------------------------------------------------------

// Never attack. Baseline — should basically always lose.
function passive(_api) {}

// Attack random legal moves until none remain (reckless: attacks even when weaker).
function randomAll(api) {
  let moves = api.legalMoves();
  while (moves.length) {
    const m = moves[Math.floor(api.rng() * moves.length)];
    api.attack(m.from, m.to);
    moves = api.legalMoves();
  }
}

// Repeatedly attack the weakest reachable enemy, regardless of odds.
function greedyWeakest(api) {
  for (;;) {
    const moves = api.legalMoves();
    if (!moves.length) break;
    let best = moves[0];
    for (const m of moves) if (api.node(m.to).strength < api.node(best.to).strength) best = m;
    api.attack(best.from, best.to);
  }
}

// Only attack when strictly stronger (favorable odds), targeting the weakest such
// enemy with the strongest available attacker. This is the bots' own heuristic,
// applied by RED — a solid, safe expander.
function safeExpand(api) {
  for (;;) {
    const moves = api.legalMoves().filter(m => api.node(m.from).strength > api.node(m.to).strength);
    if (!moves.length) break;
    // weakest target, then strongest attacker
    let best = moves[0];
    for (const m of moves) {
      const dt = api.node(m.to).strength, db = api.node(best.to).strength;
      if (dt < db || (dt === db && api.node(m.from).strength > api.node(best.from).strength)) best = m;
    }
    api.attack(best.from, best.to);
  }
}

// Like safeExpand but only commits to attacks with a comfortable margin (>= +2),
// preserving army for clean captures. Falls back to any strictly-stronger attack
// if no big-margin move exists.
function cautiousExpand(api) {
  for (;;) {
    const all = api.legalMoves().filter(m => api.node(m.from).strength > api.node(m.to).strength);
    if (!all.length) break;
    const big = all.filter(m => api.node(m.from).strength - api.node(m.to).strength >= 2);
    const pool = big.length ? big : all;
    let best = pool[0];
    for (const m of pool) if (api.node(m.to).strength < api.node(best.to).strength) best = m;
    api.attack(best.from, best.to);
  }
}

const SAMPLE_POLICIES = { passive, randomAll, greedyWeakest, safeExpand, cautiousExpand };

module.exports = {
  makeGame, turnApi, playGame, scorePolicy,
  SAMPLE_POLICIES, passive, randomAll, greedyWeakest, safeExpand, cautiousExpand,
};

// --- CLI: benchmark the sample policies -------------------------------------
if (require.main === module) {
  const games = Number(process.argv[2]) || 100;
  console.log(`\nNetwork Wars — policy benchmark (${games} games each, fixed seeds)\n`);
  const pad = (s, n) => String(s).padEnd(n);
  const padl = (s, n) => String(s).padStart(n);
  console.log(pad('policy', 16), padl('winrate', 9), padl('avgTurns→win', 14), padl('avgLen', 8), padl('ms/game', 9));
  console.log('-'.repeat(58));
  for (const [name, policy] of Object.entries(SAMPLE_POLICIES)) {
    const r = scorePolicy(policy, { games });
    console.log(
      pad(name, 16),
      padl((r.winRate * 100).toFixed(1) + '%', 9),
      padl(r.avgTurnsToWin ? r.avgTurnsToWin.toFixed(2) : '—', 14),
      padl(r.avgGameLength.toFixed(1), 8),
      padl(r.msPerGame.toFixed(2), 9),
    );
  }
  console.log('');
}
