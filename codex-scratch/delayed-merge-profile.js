'use strict';

// Strict diagnostic for codexDelayedMerge. The policy only receives the normal
// public API; this script records visible state snapshots and attack outcomes.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';
const WIN_NODES = 24;
const MAX_TURNS = 300;

function cloneState(state) {
  return {
    nodes: state.nodes.map(n => ({
      id: n.id,
      x: n.x,
      y: n.y,
      owner: n.owner,
      strength: n.strength,
    })),
    adj: state.adj,
  };
}

function counts(state) {
  const out = Object.fromEntries(FACTIONS.map(f => [f, 0]));
  for (const n of state.nodes) out[n.owner]++;
  return out;
}

function legalMoves(state, faction = HUMAN) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      if (state.nodes[to].owner !== faction) moves.push({ from: n.id, to });
    }
  }
  return moves;
}

function components(state, faction = HUMAN) {
  const seen = new Set();
  const out = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || seen.has(n.id)) continue;
    const comp = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const nb of state.adj[id]) {
        if (!seen.has(nb) && state.nodes[nb].owner === faction) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

function summarize(state) {
  const c = counts(state);
  const moves = legalMoves(state);
  const comps = components(state);
  let goodMoves = 0;
  let strongMoves = 0;
  let bestP = 0;
  let redStrength = 0;
  let maxRedStrength = 0;
  let vulnerable = 0;

  for (const n of state.nodes) {
    if (n.owner !== HUMAN) continue;
    redStrength += n.strength;
    maxRedStrength = Math.max(maxRedStrength, n.strength);
    if (state.adj[n.id].some(nb => state.nodes[nb].owner !== HUMAN && state.nodes[nb].strength > n.strength)) {
      vulnerable++;
    }
  }

  for (const move of moves) {
    const p = codex.captureProbability(
      state.nodes[move.from].strength,
      state.nodes[move.to].strength,
    );
    bestP = Math.max(bestP, p);
    if (p > 0.4) goodMoves++;
    if (state.nodes[move.from].strength > state.nodes[move.to].strength) strongMoves++;
  }

  return {
    red: c.red,
    maxEnemy: Math.max(...BOTS.map(f => c[f])),
    leaderGap: Math.max(...BOTS.map(f => c[f])) - c.red,
    redStrength,
    maxRedStrength,
    legalMoves: moves.length,
    strongMoves,
    goodMoves,
    bestP,
    comps: comps.length,
    largestComp: comps.reduce((best, comp) => Math.max(best, comp.length), 0),
    vulnerable,
  };
}

function bucket(value, size) {
  return Math.floor(value / size) * size;
}

function addBucket(map, key, won) {
  const rec = map.get(key) || { games: 0, wins: 0 };
  rec.games++;
  if (won) rec.wins++;
  map.set(key, rec);
}

function instrumentApi(state, attacks) {
  const base = sim.turnApi(state, G.HUMAN);
  return {
    ...base,
    attack(from, to) {
      const fromStart = state.nodes[from].strength;
      const toStart = state.nodes[to].strength;
      const defender = state.nodes[to].owner;
      const result = base.attack(from, to);
      attacks.push({
        from,
        to,
        defender,
        fromStart,
        toStart,
        captured: result.captured,
        fromStrength: result.fromStrength,
        toStrength: result.toStrength,
      });
      return result;
    },
  };
}

function playProfile(policy, seed) {
  const state = sim.makeGame(seed);
  const record = {
    seed,
    opening: summarize(cloneState(state)),
    afterWait: null,
    firstActive: { attacks: 0, captures: 0, firstCaptureP: null },
    turns: 0,
    won: false,
    winner: null,
    counts: null,
  };

  while (!G.checkWinner(state) && record.turns < MAX_TURNS) {
    record.turns++;
    if (record.turns === 2) record.afterWait = summarize(cloneState(state));

    const attacks = [];
    try {
      policy(instrumentApi(state, attacks));
    } catch (_) {
      // Match sim.playGame behavior: policy errors simply end RED's turn.
    }

    if (record.turns === 2) {
      record.firstActive.attacks = attacks.length;
      record.firstActive.captures = attacks.filter(a => a.captured).length;
      if (attacks[0]) {
        record.firstActive.firstCaptureP = codex.captureProbability(
          attacks[0].fromStart,
          attacks[0].toStart,
        );
      }
    }

    if (G.checkWinner(state)) break;
    G.reinforce(state, G.HUMAN);
    if (G.checkWinner(state)) break;
    const log = [];
    for (const bot of G.BOTS) {
      G.runBotTurn(state, bot, log);
      if (G.checkWinner(state)) break;
    }
  }

  record.winner = G.checkWinner(state);
  record.won = record.winner === G.HUMAN;
  record.counts = G.counts(state);
  if (!record.afterWait) record.afterWait = summarize(cloneState(state));
  return record;
}

function printBuckets(title, buckets, minGames = 20) {
  const rows = [...buckets.entries()]
    .filter(([, rec]) => rec.games >= minGames)
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  console.log(`\n${title}`);
  for (const [key, rec] of rows) {
    console.log(`${key.padEnd(18)} ${String(rec.wins).padStart(4)}/${String(rec.games).padEnd(4)} ${(rec.wins / rec.games * 100).toFixed(1)}%`);
  }
}

function main() {
  const games = Number(process.argv[2]) || 2000;
  const seedBase = Number(process.argv[3]) || 1;
  const policy = codex.makeDelayedRankedStrategy(codex.DELAYED_MERGE_RANKED_OPTIONS);
  const buckets = {
    openingGood: new Map(),
    afterWaitGood: new Map(),
    afterWaitRed: new Map(),
    afterWaitGap: new Map(),
    firstAttacks: new Map(),
    firstCaptures: new Map(),
    firstP: new Map(),
    finalWinner: new Map(),
  };
  let wins = 0;

  for (let i = 0; i < games; i++) {
    const rec = playProfile(policy, seedBase + i);
    if (rec.won) wins++;
    addBucket(buckets.openingGood, String(bucket(rec.opening.goodMoves, 3)), rec.won);
    addBucket(buckets.afterWaitGood, String(bucket(rec.afterWait.goodMoves, 3)), rec.won);
    addBucket(buckets.afterWaitRed, String(rec.afterWait.red), rec.won);
    addBucket(buckets.afterWaitGap, String(rec.afterWait.leaderGap), rec.won);
    addBucket(buckets.firstAttacks, String(Math.min(10, rec.firstActive.attacks)), rec.won);
    addBucket(buckets.firstCaptures, String(Math.min(8, rec.firstActive.captures)), rec.won);
    addBucket(
      buckets.firstP,
      rec.firstActive.firstCaptureP === null ? 'none' : String(bucket(rec.firstActive.firstCaptureP * 100, 10)),
      rec.won,
    );
    addBucket(buckets.finalWinner, rec.winner || 'draw', rec.won);
  }

  console.log(`codexDelayedMerge profile: ${wins}/${games} ${(wins / games * 100).toFixed(1)}% seeds ${seedBase}..${seedBase + games - 1}`);
  printBuckets('opening good move count', buckets.openingGood);
  printBuckets('after-wait good move count', buckets.afterWaitGood);
  printBuckets('after-wait red count', buckets.afterWaitRed);
  printBuckets('after-wait leader gap', buckets.afterWaitGap);
  printBuckets('first active attacks', buckets.firstAttacks);
  printBuckets('first active captures', buckets.firstCaptures);
  printBuckets('first active first-attack p%', buckets.firstP);
  printBuckets('winner', buckets.finalWinner, 1);
}

if (require.main === module) main();

