'use strict';
// ---------------------------------------------------------------------------
// Network Wars — RED strategy: "deny-leader snowball"
//
// Derived empirically (see experiments.js). Win rate ~38% across thousands of
// seeded games, vs ~27% for the best sample policy (randomAll) and the ~20%
// "fair share" of a symmetric 5-way race.
//
// WHY THIS WORKS — three facts about the engine drive the whole strategy:
//
//   1. The game is a SNOWBALL RACE, not a survival game. Outcomes are bimodal:
//      you either reach 24 nodes first or a bot does. "Playing safe" just loses
//      to whichever bot snowballs fastest, so the strategy is all-in aggression.
//
//   2. Reinforcement = the size of your LARGEST connected component, dumped onto
//      its border nodes. One big blob compounds (more nodes -> more reinforcement
//      -> more captures). Since RED's 6 starting nodes are scattered, the single
//      highest-value early play is CAPTURING THE NODES THAT MERGE YOUR FRAGMENTS
//      into one component. We score every candidate attack by how much it grows
//      our largest component.
//
//   3. The race is decided by the LEADING bot. Capturing a node from the current
//      node-count leader does double duty: RED +1 and the runaway -1. Biasing
//      target selection toward the largest enemy faction was the single biggest
//      win-rate jump in testing (~31% -> ~38%).
//
// The move score combines these: grow*10 + captureProb*2 + leaderSize*1, gated
// by a low capture-probability floor (0.1) so we skip near-hopeless attacks but
// still press hard. When nothing clears the floor we mop up the best-odds attack
// anyway — stopping early hands bots free turns.
// ---------------------------------------------------------------------------

const ATTACKER_P = 0.55; // must match game.js ATTACKER_WIN_P

// Probability the attacker (stack `a`) captures a defender (stack `d`). Modelled
// as a race: attacker needs `d` per-flip wins (defender->0) before `a-1` losses
// (attacker->1). With fixed per-flip win prob p this equals the chance of >= d
// wins in (d+a-2) Bernoulli(p) trials.
const _pcache = new Map();
function captureProb(a, d, p = ATTACKER_P) {
  if (a <= 1) return 0;
  if (d <= 0) return 1;
  const key = a * 1000 + d;
  const hit = _pcache.get(key);
  if (hit !== undefined) return hit;
  const n = d + a - 2;
  let prob = 0;
  let term = Math.pow(1 - p, n); // k = 0 term
  for (let k = 0; k <= n; k++) {
    if (k >= d) prob += term;
    term = term * (p / (1 - p)) * ((n - k) / (k + 1));
  }
  if (prob > 1) prob = 1;
  _pcache.set(key, prob);
  return prob;
}

// Size of RED's largest connected component, optionally pretending `flipId` is
// already owned by RED (used to preview a capture's effect on reinforcement).
function largestComp(api, faction, flipId = -1) {
  const owned = (id) => id === flipId || api.node(id).owner === faction;
  const seen = new Set();
  let best = 0;
  for (const n of api.nodes) {
    if (!owned(n.id) || seen.has(n.id)) continue;
    let size = 0; const stack = [n.id]; seen.add(n.id);
    while (stack.length) {
      const id = stack.pop(); size++;
      for (const nb of api.neighbors(id)) if (owned(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    if (size > best) best = size;
  }
  return best;
}

// The strategy. Plays RED's entire turn via repeated api.attack(...) calls.
const FLOOR = 0.10;   // skip attacks below this capture probability...
const W_GROW = 10;    // ...prioritize merging/extending our largest component...
const W_PC = 2;       // ...then favorable odds...
const W_LEAD = 1;     // ...then chip away at the current node-count leader.

function denyLeader(api) {
  for (let guard = 0; guard < 2000; guard++) {
    const moves = api.legalMoves();
    if (!moves.length) break;
    const counts = api.counts();
    const cur = largestComp(api, api.faction);

    // Best scoring attack above the probability floor.
    let best = null, bestScore = -Infinity;
    for (const m of moves) {
      const a = api.node(m.from).strength, d = api.node(m.to).strength;
      const pc = captureProb(a, d);
      if (pc < FLOOR) continue;
      const grow = largestComp(api, api.faction, m.to) - cur;
      const leaderSize = counts[api.node(m.to).owner];
      const score = grow * W_GROW + pc * W_PC + leaderSize * W_LEAD;
      if (score > bestScore) { best = m; bestScore = score; }
    }

    // Nothing above the floor: mop up the single best-odds attack so we never
    // end the turn with attacks left on the table (that just helps the bots).
    if (!best) {
      let mp = -1;
      for (const m of moves) {
        const pc = captureProb(api.node(m.from).strength, api.node(m.to).strength);
        if (pc > mp) { best = m; mp = pc; }
      }
      if (!best) break;
    }

    api.attack(best.from, best.to);
  }
}

module.exports = { denyLeader, captureProb, largestComp };

// --- confirmation benchmark -------------------------------------------------
if (require.main === module) {
  const { scorePolicy, randomAll, safeExpand, playGame } = require('./sim');
  const games = Number(process.argv[2]) || 2000;
  const deathRate = (policy) => {
    let dead = 0;
    for (let i = 0; i < games; i++) if (playGame(policy, 1 + i).counts.red === 0) dead++;
    return dead / games;
  };
  const pad = (s, n) => String(s).padEnd(n);
  const padl = (s, n) => String(s).padStart(n);
  console.log(`\nFinal strategy confirmation (${games} games, seeds 1..${games})\n`);
  console.log(pad('policy', 16), padl('winrate', 9), padl('deathrate', 10), padl('avgTurns→win', 14));
  console.log('-'.repeat(54));
  for (const [name, p] of [['denyLeader', denyLeader], ['randomAll', randomAll], ['safeExpand', safeExpand]]) {
    const r = scorePolicy(p, { games });
    console.log(
      pad(name, 16),
      padl((r.winRate * 100).toFixed(1) + '%', 9),
      padl((deathRate(p) * 100).toFixed(1) + '%', 10),
      padl(r.avgTurnsToWin.toFixed(2), 14),
    );
  }
  console.log('');
}
