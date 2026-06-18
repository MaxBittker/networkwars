'use strict';
// Experimentation harness for RED policies. Run: node experiments.js [games]
const G = require('./game');
const { scorePolicy } = require('./sim');

const ATTACKER_P = 0.55;

// --- Capture probability (gambler's ruin / race) ---------------------------
// Attacker stack `a` vs defender `d`. Attacker must score `d` per-flip wins
// (defender->0) before scoring (a-1) losses (attacker->1). Race to d vs a-1
// with per-flip win prob p. P(attacker wins) = P(>=d wins in d+a-2 trials).
const _pcache = new Map();
function captureProb(a, d, p = ATTACKER_P) {
  if (a <= 1) return 0;
  if (d <= 0) return 1;
  const key = a * 1000 + d;
  const hit = _pcache.get(key);
  if (hit !== undefined) return hit;
  const n = d + a - 2;           // fixed trials
  const need = d;                // attacker needs >= d wins
  // sum_{k=need}^{n} C(n,k) p^k (1-p)^(n-k)
  let prob = 0;
  // iterative binomial term
  let term = Math.pow(1 - p, n); // k=0 term
  for (let k = 0; k <= n; k++) {
    if (k >= need) prob += term;
    // advance to k+1
    term = term * (p / (1 - p)) * ((n - k) / (k + 1));
  }
  if (prob > 1) prob = 1;
  _pcache.set(key, prob);
  return prob;
}

// --- helpers ----------------------------------------------------------------
function enemyNeighbors(api, id) {
  return api.neighbors(id).filter(nb => api.node(nb).owner !== api.faction);
}

// =========================================================================
// Policy: threshold — attack best capture-prob move while above threshold.
// =========================================================================
function makeThreshold(thresh) {
  return function (api) {
    for (let guard = 0; guard < 1000; guard++) {
      const moves = api.legalMoves();
      let best = null, bestP = 0;
      for (const m of moves) {
        const a = api.node(m.from).strength, d = api.node(m.to).strength;
        const pc = captureProb(a, d);
        if (pc < thresh) continue;
        // prefer higher capture prob, tie-break weaker target (more captures/army)
        if (!best || pc > bestP || (pc === bestP && d < api.node(best.to).strength)) {
          best = m; bestP = pc;
        }
      }
      if (!best) break;
      api.attack(best.from, best.to);
    }
  };
}

// =========================================================================
// Policy: spearhead — concentrate force, punch weakest enemy from strongest
// owned node, chain through captures. Attack while capture prob >= thresh.
// =========================================================================
function makeSpearhead(thresh) {
  return function (api) {
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      let best = null, bestScore = -Infinity;
      for (const m of moves) {
        const a = api.node(m.from).strength, d = api.node(m.to).strength;
        const pc = captureProb(a, d);
        if (pc < thresh) continue;
        // score: capture prob primary, prefer weak target & strong attacker
        const score = pc * 100 - d + a * 0.1;
        if (score > bestScore) { best = m; bestScore = score; }
      }
      if (!best) break;
      api.attack(best.from, best.to);
    }
  };
}

// =========================================================================
// Policy: maxExpand — capture as many nodes as possible. Greedily take any
// move with capture prob >= thresh, weakest target first (cheapest captures).
// =========================================================================
function makeMaxExpand(thresh) {
  return function (api) {
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      let best = null, bestKey = -Infinity;
      for (const m of moves) {
        const a = api.node(m.from).strength, d = api.node(m.to).strength;
        const pc = captureProb(a, d);
        if (pc < thresh) continue;
        // weakest target first; tie-break by capture prob
        const key = -d * 1000 + pc * 100;
        if (key > bestKey) { best = m; bestKey = key; }
      }
      if (!best) break;
      api.attack(best.from, best.to);
    }
  };
}

// =========================================================================
// Policy: bestFirst — never stop while a legal move exists, but always take
// the highest-capture-prob move first (randomAll's volume, optimal order).
// =========================================================================
function bestFirst(api) {
  for (let guard = 0; guard < 2000; guard++) {
    const moves = api.legalMoves();
    if (!moves.length) break;
    let best = moves[0], bestP = -1;
    for (const m of moves) {
      const pc = captureProb(api.node(m.from).strength, api.node(m.to).strength);
      if (pc > bestP) { best = m; bestP = pc; }
    }
    api.attack(best.from, best.to);
  }
}

// Like bestFirst but tie-break toward weakest target (cheaper captures).
function bestFirstWeak(api) {
  for (let guard = 0; guard < 2000; guard++) {
    const moves = api.legalMoves();
    if (!moves.length) break;
    let best = moves[0], bestP = -1, bestD = Infinity;
    for (const m of moves) {
      const d = api.node(m.to).strength;
      const pc = captureProb(api.node(m.from).strength, d);
      if (pc > bestP || (pc === bestP && d < bestD)) { best = m; bestP = pc; bestD = d; }
    }
    api.attack(best.from, best.to);
  }
}

// Two-phase: favorable captures first (prob>=thresh, weakest target), then
// throw everything remaining (randomAll-style) regardless of odds.
function makeTwoPhase(thresh) {
  return function (api) {
    // phase 1: cheap favorable captures
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      let best = null, bestKey = -Infinity;
      for (const m of moves) {
        const a = api.node(m.from).strength, d = api.node(m.to).strength;
        const pc = captureProb(a, d);
        if (pc < thresh) continue;
        const key = pc * 100 - d;
        if (key > bestKey) { best = m; bestKey = key; }
      }
      if (!best) break;
      api.attack(best.from, best.to);
    }
    // phase 2: mop up everything, best-prob first
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      if (!moves.length) break;
      let best = moves[0], bestP = -1;
      for (const m of moves) {
        const pc = captureProb(api.node(m.from).strength, api.node(m.to).strength);
        if (pc > bestP) { best = m; bestP = pc; }
      }
      api.attack(best.from, best.to);
    }
  };
}

// --- component analysis (read-only, on the live api view) ------------------
// Largest connected component size for `faction` given current ownership,
// optionally pretending node `flipId` is owned by faction (capture preview).
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

// =========================================================================
// Policy: connect — value captures by how much they grow RED's largest
// connected component (reinforcement fuel), gated by a capture-prob floor.
// Keep attacking while any move clears the floor.
// =========================================================================
function makeConnect(floor, mopUp) {
  return function (api) {
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      const cur = largestComp(api, api.faction);
      let best = null, bestScore = -Infinity;
      for (const m of moves) {
        const a = api.node(m.from).strength, d = api.node(m.to).strength;
        const pc = captureProb(a, d);
        if (pc < floor) continue;
        const grow = largestComp(api, api.faction, m.to) - cur;
        // prioritize component growth, then capture prob, then weak target
        const score = grow * 10 + pc * 2 - d * 0.05;
        if (score > bestScore) { best = m; bestScore = score; }
      }
      if (!best) {
        if (!mopUp) break;
        // mop up: take any remaining move, best prob first
        let mb = null, mp = -1;
        for (const m of moves) {
          const pc = captureProb(api.node(m.from).strength, api.node(m.to).strength);
          if (pc > mp) { mb = m; mp = pc; }
        }
        if (!mb) break;
        best = mb;
      }
      api.attack(best.from, best.to);
    }
  };
}

// =========================================================================
// Policy: spearDeep — repeatedly drive the single strongest stack into its
// weakest enemy neighbor, chaining captures forward. Concentrates force.
// After the spear stalls, repeat with the next strongest stack, etc.
// =========================================================================
function spearDeep(api) {
  for (let guard = 0; guard < 2000; guard++) {
    const moves = api.legalMoves();
    if (!moves.length) break;
    // pick from the strongest attacker; among its targets, the weakest
    let best = null;
    for (const m of moves) {
      const a = api.node(m.from).strength, d = api.node(m.to).strength;
      if (!best) { best = m; continue; }
      const ba = api.node(best.from).strength, bd = api.node(best.to).strength;
      if (a > ba || (a === ba && d < bd)) best = m;
    }
    api.attack(best.from, best.to);
  }
}

// =========================================================================
// Policy: hybrid — phase 1: component-merging favorable captures (build one
// blob). phase 2: drive strongest stacks deep as spears (grab territory).
// All-in: never stops while legal moves remain.
// =========================================================================
function makeHybrid(floor) {
  return function (api) {
    // phase 1: merge components with favorable captures
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      const cur = largestComp(api, api.faction);
      let best = null, bestScore = 0;
      for (const m of moves) {
        const a = api.node(m.from).strength, d = api.node(m.to).strength;
        const pc = captureProb(a, d);
        if (pc < floor) continue;
        const grow = largestComp(api, api.faction, m.to) - cur;
        if (grow <= 0) continue;            // only merges/extensions in phase 1
        const score = grow * 10 + pc;
        if (score > bestScore) { best = m; bestScore = score; }
      }
      if (!best) break;
      api.attack(best.from, best.to);
    }
    // phase 2: spear deep with everything, weakest-target-from-strongest
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      if (!moves.length) break;
      let best = null;
      for (const m of moves) {
        const a = api.node(m.from).strength, d = api.node(m.to).strength;
        const pc = captureProb(a, d);
        if (pc < floor) continue;
        if (!best) { best = m; continue; }
        const ba = api.node(best.from).strength, bd = api.node(best.to).strength;
        if (a > ba || (a === ba && d < bd)) best = m;
      }
      if (!best) {
        // nothing above floor: mop up best-prob to keep pressing
        let mb = null, mp = -1;
        for (const m of moves) {
          const pc = captureProb(api.node(m.from).strength, api.node(m.to).strength);
          if (pc > mp) { mb = m; mp = pc; }
        }
        if (!mb) break; best = mb;
      }
      api.attack(best.from, best.to);
    }
  };
}

// =========================================================================
// Policy: planner — greedy 1-ply. Clone owner/strength, apply each legal
// move's EXPECTED outcome (capture if prob>=0.5, resulting strengths), score
// the board, execute the best real move. All-in via mop-up.
// State value = redNodes*W_NODE + largestCompSize*W_COMP + sqrt(totalStr).
// =========================================================================
function snapshot(api) {
  const owner = api.nodes.map(n => n.owner);
  const str = api.nodes.map(n => n.strength);
  return { owner, str };
}
function snapLargestComp(api, owner, faction) {
  const seen = new Set(); let best = 0;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== faction || seen.has(i)) continue;
    let size = 0; const stack = [i]; seen.add(i);
    while (stack.length) {
      const id = stack.pop(); size++;
      for (const nb of api.neighbors(id)) if (owner[nb] === faction && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    if (size > best) best = size;
  }
  return best;
}
function makePlanner(floor, { wNode = 3, wComp = 3, wStr = 0.4 } = {}) {
  return function (api) {
    const F = api.faction;
    const value = (owner, str) => {
      let nodes = 0, total = 0;
      for (let i = 0; i < owner.length; i++) if (owner[i] === F) { nodes++; total += str[i]; }
      return nodes * wNode + snapLargestComp(api, owner, F) * wComp + Math.sqrt(total) * wStr;
    };
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      if (!moves.length) break;
      const snap = snapshot(api);
      let best = null, bestVal = -Infinity, bestPc = -1;
      for (const m of moves) {
        const a = snap.str[m.from], d = snap.str[m.to];
        const pc = captureProb(a, d);
        // expected outcome
        const owner = snap.owner.slice(), str = snap.str.slice();
        if (pc >= 0.5) {
          // assume capture: attacker leaves 1, moves rest; expected losses ~ d/p
          owner[m.to] = F;
          const expSpent = Math.min(a - 1, Math.round(d / ATTACKER_P));
          str[m.to] = Math.max(1, a - 1 - Math.max(0, expSpent - d));
          str[m.from] = 1;
        } else {
          str[m.from] = 1; // assume failed, drops to 1
        }
        const v = value(owner, str) + pc * 0.5; // tiny tiebreak toward sure things
        if (v > bestVal || (v === bestVal && pc > bestPc)) { best = m; bestVal = v; bestPc = pc; }
      }
      // only attack if above floor, else mop up best prob
      const pcBest = captureProb(api.node(best.from).strength, api.node(best.to).strength);
      if (pcBest < floor) {
        let mb = null, mp = -1;
        for (const m of moves) {
          const pc = captureProb(api.node(m.from).strength, api.node(m.to).strength);
          if (pc > mp) { mb = m; mp = pc; }
        }
        if (!mb || mp <= 0) break; best = mb;
      }
      api.attack(best.from, best.to);
    }
  };
}

// Deny-leader: prioritize capturing from the faction currently holding the
// most nodes (slow the runaway), while still favoring component growth.
// wLead scales how aggressively we chase the leader's nodes.
function makeDenyLeader(floor, { wGrow = 10, wPc = 2, wLead = 1, leadPow = 1 } = {}) {
  return function (api) {
    for (let guard = 0; guard < 2000; guard++) {
      const moves = api.legalMoves();
      if (!moves.length) break;
      const c = api.counts();
      const cur = largestComp(api, api.faction);
      let best = null, bestScore = -Infinity;
      for (const m of moves) {
        const a = api.node(m.from).strength, d = api.node(m.to).strength;
        const pc = captureProb(a, d);
        if (pc < floor) continue;
        const grow = largestComp(api, api.faction, m.to) - cur;
        const lead = Math.pow(c[api.node(m.to).owner], leadPow);
        const score = grow * wGrow + pc * wPc + lead * wLead;
        if (score > bestScore) { best = m; bestScore = score; }
      }
      if (!best) {
        let mb = null, mp = -1;
        for (const m of moves) {
          const pc = captureProb(api.node(m.from).strength, api.node(m.to).strength);
          if (pc > mp) { mb = m; mp = pc; }
        }
        if (!mb) break; best = mb;
      }
      api.attack(best.from, best.to);
    }
  };
}

const POLICIES = {
  randomAll: require('./sim').randomAll,
  'connect.20mop': makeConnect(0.20, true),
  'deny.15': makeDenyLeader(0.15),
  'deny.10': makeDenyLeader(0.10),
  'deny.05': makeDenyLeader(0.05),
  'deny.0': makeDenyLeader(0.0),
};

if (require.main === module) {
  const games = Number(process.argv[2]) || 300;
  const seedBase = Number(process.argv[3]) || 1;
  const pad = (s, n) => String(s).padEnd(n);
  const padl = (s, n) => String(s).padStart(n);
  console.log(`\nExperiments (${games} games each, seedBase ${seedBase})\n`);
  console.log(pad('policy', 16), padl('winrate', 9), padl('deathrate', 10), padl('avgTurns→win', 14));
  console.log('-'.repeat(54));
  const rows = [];
  for (const [name, policy] of Object.entries(POLICIES)) {
    const r = scorePolicy(policy, { games, seedBase });
    // death rate: fraction of games red ends with 0 nodes
    let dead = 0;
    for (let i = 0; i < games; i++) {
      const g = require('./sim').playGame(policy, seedBase + i);
      if (g.counts.red === 0) dead++;
    }
    r.deathRate = dead / games;
    rows.push([name, r]);
  }
  rows.sort((a, b) => b[1].winRate - a[1].winRate);
  for (const [name, r] of rows) {
    console.log(
      pad(name, 16),
      padl((r.winRate * 100).toFixed(1) + '%', 9),
      padl((r.deathRate * 100).toFixed(1) + '%', 10),
      padl(r.avgTurnsToWin ? r.avgTurnsToWin.toFixed(2) : '—', 14),
    );
  }
  console.log('');
}

module.exports = {
  captureProb,
  makeThreshold,
  makeSpearhead,
  makeMaxExpand,
  makeConnect,
  makeTwoPhase,
  makeHybrid,
  makePlanner,
  makeDenyLeader,
  bestFirst,
  bestFirstWeak,
  spearDeep,
  largestComp,
  POLICIES,
};
