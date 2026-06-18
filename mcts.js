'use strict';
// ---------------------------------------------------------------------------
// Network Wars — a simple MCTS-inspired RED policy.
//
// This is "flat UCB at the root" (a.k.a. one-ply Monte Carlo with adaptive
// rollout budgeting), not a full tree search — but it captures the heart of
// MCTS: evaluate candidate actions by stochastic rollouts to the end of the
// game, and spend more rollouts on the promising candidates (UCB1).
//
// Design choices that matter:
//
//   * NO SEED EXPLOITATION. Rollouts use a private RNG stream that is
//     independent of the game's hidden battle RNG. We never read api.rng(),
//     never recover the seed, never fingerprint the board. The only thing we
//     "know" is the public board state, exactly like a human watching.
//
//   * REAL ENGINE for playouts. We clone the visible board into a throwaway
//     state and roll it forward with the *actual* game.js engine (battles,
//     reinforcement, the deterministic bots). So our simulated dynamics match
//     the true game exactly, only the dice differ.
//
//   * STRONG ROLLOUT POLICY. In MCTS the rollout (default) policy quality
//     dominates. We reuse the project's best fast heuristic — the ranked move
//     scorer from codex-strategy — to play RED inside rollouts, instead of a
//     random/greedy playout. Good playouts -> trustworthy value estimates.
//
// At each real decision the policy:
//   1. lets the strong heuristic decide whether to keep attacking (stop gate),
//   2. enumerates the top-K candidate targets,
//   3. runs a rollout budget, each rollout picking a candidate by UCB1,
//   4. plays the candidate with the best mean win-rate.
//
// RESULTS (no seed exploitation; bots are the deterministic game bots):
//   rollout=cheap  (bot-style)   ~52%
//   rollout=strong (ranked 50%)  ~57%   (120 games, ~0.5s/game)
//   rollout=safety (ranked 62%)  ~65%   (60 games,  ~4s/game)
// All sit BELOW the project's best hand-tuned heuristic, codexModalScout
// (~68.7%). Why: a 1-ply Monte-Carlo's value estimate is only as good as its
// rollout policy, and every rollout policy fast enough to use is weaker than
// modalScout's own modal look-ahead, so the rollouts add noise, not signal.
// Reaching the requested >80% appears infeasible without seed exploitation:
// a "best-of-portfolio" oracle (any of 7 strategies wins the seed) tops out at
// ~92%, but that edge comes from knowing which line wins for the ACTUAL dice.
// Averaging over random (seed-free) dice — the only legitimate signal here —
// collapses that headroom back to ~68%. See the chat summary for the full sweep.
// ---------------------------------------------------------------------------

const G = require('./game');
const codex = require('./codex-strategy/strategy');

const HUMAN = 'red';
const BOTS = G.BOTS;
const WIN_NODES = G.WIN_NODES;

// Rollout policy: the project's tuned ranked heuristic. Fast and ~60% on its
// own, which makes it a strong default policy for the playouts.
const ROLLOUT_OPTIONS = codex.DELAYED_MERGE_RANKED_OPTIONS;

// --- private RNG ------------------------------------------------------------
// One global counter so rollouts are reproducible across runs but completely
// independent of the game's hidden battle seed. (Not derived from api.rng().)
let rolloutSeedCounter = 0x12345678;
function nextRolloutRng() {
  rolloutSeedCounter = (rolloutSeedCounter + 0x9e3779b9) | 0;
  return G.makeRng(rolloutSeedCounter >>> 0);
}

// --- state cloning ----------------------------------------------------------
// Build a self-contained engine state {nodes, adj, rng} from the public API.
function cloneFromApi(api, rng) {
  const nodes = api.nodes.map(n => ({
    id: n.id, x: n.x, y: n.y, owner: n.owner, strength: n.strength,
  }));
  const adj = nodes.map(n => api.neighbors(n.id).slice());
  return { nodes, adj, rng };
}

function cloneState(state, rng) {
  return {
    nodes: state.nodes.map(n => ({
      id: n.id, x: n.x, y: n.y, owner: n.owner, strength: n.strength,
    })),
    adj: state.adj,   // adjacency never mutates; safe to share
    rng,
  };
}

function counts(state) { return G.counts(state); }

// --- rollout policies -------------------------------------------------------
// CHEAP: RED expands like the bots — attack the weakest strictly-beatable
// neighbor. O(nodes·deg) per attack, no capture-prob math. Fast playouts.
function cheapRedTurn(state) {
  let guard = 0;
  while (guard++ < 200) {
    const move = G.bestBotMove(state, HUMAN);
    if (!move) return;
    G.resolveBattle(state, move.from, move.to);
    if (G.checkWinner(state)) return;
  }
}

// STRONG: RED plays the tuned ranked heuristic. Higher-quality playouts but
// markedly slower (capture-prob + component labelling per attack).
function strongRedTurn(state) {
  let guard = 0;
  while (guard++ < 200) {
    if (G.checkWinner(state)) return;
    const move = codex.selectRankedMove(state, ROLLOUT_OPTIONS);
    if (!move) return;
    G.resolveBattle(state, move.from, move.to);
  }
}

// SAFETY: the project's mid-tier safety heuristic (~62% standalone). Slower
// than `strong` but a much better default policy, so rollout values are more
// trustworthy.
const SAFETY_OPTS = { rankedOptions: ROLLOUT_OPTIONS, minScore: 210, splitWeight: 25, threatenedWeight: 36 };
function safetyRedTurn(state) {
  let guard = 0;
  while (guard++ < 200) {
    if (G.checkWinner(state)) return;
    const move = codex.selectSafetyRankedMove(state, SAFETY_OPTS);
    if (!move) return;
    G.resolveBattle(state, move.from, move.to);
  }
}

let rolloutRedTurn = cheapRedTurn;   // swapped by makeMcts(cfg.rollout)

// Run one playout to terminal (or horizon) and return value in [0,1].
//   firstMove   : the candidate attack to commit first (null for "stop")
//   endTurnNow  : true => end RED's turn immediately (the "stop" candidate)
function playout(state, firstMove, endTurnNow, horizon) {
  // --- RED's current turn (we may be mid-turn in the real game) ---
  if (firstMove) {
    G.resolveBattle(state, firstMove.from, firstMove.to);
    const w = G.checkWinner(state);
    if (w) return w === HUMAN ? 1 : 0;
  }
  if (!endTurnNow) {
    rolloutRedTurn(state);
    const w = G.checkWinner(state);
    if (w) return w === HUMAN ? 1 : 0;
  }
  // --- end of RED's turn: reinforce, then the bots ---
  G.reinforce(state, HUMAN);
  let w = G.checkWinner(state);
  if (w) return w === HUMAN ? 1 : 0;
  for (const bot of BOTS) {
    G.runBotTurn(state, bot, []);
    w = G.checkWinner(state);
    if (w) return w === HUMAN ? 1 : 0;
  }
  // --- subsequent full rounds ---
  for (let t = 0; t < horizon; t++) {
    rolloutRedTurn(state);
    w = G.checkWinner(state);
    if (w) return w === HUMAN ? 1 : 0;
    G.reinforce(state, HUMAN);
    w = G.checkWinner(state);
    if (w) return w === HUMAN ? 1 : 0;
    for (const bot of BOTS) {
      G.runBotTurn(state, bot, []);
      w = G.checkWinner(state);
      if (w) return w === HUMAN ? 1 : 0;
    }
  }
  // Horizon reached without a winner: smooth heuristic value from node share.
  const c = counts(state);
  const maxEnemy = Math.max(c.green, c.yellow, c.blue, c.purple);
  return Math.max(0, Math.min(1, 0.5 + (c.red - maxEnemy) / 48));
}

// --- candidate generation ---------------------------------------------------
// DECISIVENESS is anchored on the strong heuristic: `selectModalScoutMove`
// decides *whether* to keep attacking (null => stop). This keeps the real game
// short (≈ the heuristic's game length), which is what kept earlier pure-MCTS
// designs from blowing up into 80+ turn games. MCTS then only re-chooses
// *which* target among the strong heuristic's top candidates.
function candidateMoves(state, topK) {
  const anchor = codex.selectModalScoutMove(state);
  if (!anchor) return null;                       // heuristic says: stop the turn
  const moves = [anchor];
  const seen = new Set([`${anchor.from}:${anchor.to}`]);
  for (const item of codex.rankedMoveScores(state, ROLLOUT_OPTIONS)) {
    if (moves.length >= topK) break;
    const key = `${item.move.from}:${item.move.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    moves.push(item.move);
  }
  return moves;
}

// --- flat UCB1 root search over the candidate targets -----------------------
function searchBestMove(liveState, moves, { budget, horizon, c }) {
  const stats = moves.map(() => ({ n: 0, sum: 0 }));

  const runOne = (i) => {
    const rng = nextRolloutRng();
    const s = cloneState(liveState, rng);
    const v = playout(s, moves[i], false, horizon);
    stats[i].n++;
    stats[i].sum += v;
  };

  for (let i = 0; i < moves.length; i++) runOne(i);       // seed each once
  for (let total = moves.length; total < budget; total++) {
    const logT = Math.log(total);
    let bestI = 0, bestU = -Infinity;
    for (let i = 0; i < moves.length; i++) {
      const st = stats[i];
      const u = st.sum / st.n + c * Math.sqrt(logT / st.n);
      if (u > bestU) { bestU = u; bestI = i; }
    }
    runOne(bestI);
  }

  let bestI = 0, bestMean = -Infinity;
  for (let i = 0; i < moves.length; i++) {
    const mean = stats[i].sum / stats[i].n;
    if (mean > bestMean) { bestMean = mean; bestI = i; }
  }
  return moves[bestI];
}

// --- the policy -------------------------------------------------------------
function makeMcts(opts = {}) {
  const cfg = {
    budget: 120,      // rollouts per real decision
    topK: 5,          // candidate attacks considered (plus "stop")
    horizon: 40,      // max simulated rounds before falling back to heuristic
    c: 1.4,           // UCB1 exploration constant
    margin: 0.0,      // require best move to beat "stop" by this much to attack
    maxAttacks: 60,   // hard cap on real attacks per turn
    rollout: 'strong', // 'cheap' | 'strong' | 'safety' (quality/speed tradeoff)
    ...opts,
  };
  rolloutRedTurn = cfg.rollout === 'strong' ? strongRedTurn
    : cfg.rollout === 'safety' ? safetyRedTurn
    : cheapRedTurn;
  return function mctsPolicy(api) {
    for (let a = 0; a < cfg.maxAttacks; a++) {
      const live = cloneFromApi(api, null);
      if (counts(live).red >= WIN_NODES) return;

      const moves = candidateMoves(live, cfg.topK);
      if (!moves) return;                                  // heuristic: stop
      const move = moves.length === 1
        ? moves[0]
        : searchBestMove(live, moves, cfg);
      api.attack(move.from, move.to);
    }
  };
}

const mcts = makeMcts();

module.exports = { mcts, makeMcts, ROLLOUT_OPTIONS };

// --- CLI: benchmark ---------------------------------------------------------
if (require.main === module) {
  const { scorePolicy } = require('./sim');
  const games = Number(process.argv[2]) || 100;
  const seedBase = Number(process.argv[3]) || 1;
  const budget = Number(process.argv[4]) || 120;
  const topK = Number(process.argv[5]) || 5;
  const rollout = process.argv[6] || 'strong';
  const horizon = Number(process.argv[7]) || 40;

  const policy = makeMcts({ budget, topK, rollout, horizon });
  console.log(`\nMCTS benchmark — ${games} games (seeds ${seedBase}..${seedBase + games - 1}), `
    + `budget=${budget} rollouts/decision, topK=${topK}, rollout=${rollout}, horizon=${horizon}\n`);
  const t0 = process.hrtime.bigint();
  const r = scorePolicy(policy, { games, seedBase });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`winrate     : ${(r.winRate * 100).toFixed(1)}%  (${r.wins}/${games})`);
  console.log(`avgTurns→win: ${r.avgTurnsToWin ? r.avgTurnsToWin.toFixed(2) : '—'}`);
  console.log(`avgGameLen  : ${r.avgGameLength.toFixed(1)}`);
  console.log(`time        : ${(ms / 1000).toFixed(1)}s total, ${(ms / games).toFixed(0)} ms/game\n`);
}
