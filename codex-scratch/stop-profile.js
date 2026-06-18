'use strict';

// Strict diagnostic: profile per-turn attack/capture counts for a legal policy.

const G = require('../game');
const codex = require('../codex-strategy/strategy');

function makeState(seed) {
  const rng = G.makeRng(seed >>> 0);
  const board = G.buildBoard(rng);
  return { ...board, rng, policyRng: G.makeRng((seed ^ 0x9e3779b9) >>> 0) };
}

function turnApiWithLog(state, faction, turnLog) {
  let attacks = 0;
  return {
    faction,
    get nodes() { return state.nodes; },
    node: id => state.nodes[id],
    counts: () => G.counts(state),
    neighbors: id => state.adj[id],
    legalMoves: () => G.legalMoves(state, faction),
    rng: state.policyRng,
    attack(from, to) {
      if (attacks++ >= 1000) throw new Error('attack budget exceeded');
      const f = state.nodes[from];
      const t = state.nodes[to];
      if (!f || !t) throw new Error('bad node id');
      if (f.owner !== faction) throw new Error('not your node');
      if (f.strength <= 1) throw new Error('node too weak');
      if (t.owner === faction) throw new Error('own node');
      if (!state.adj[from].includes(to)) throw new Error('nodes not linked');
      const r = G.resolveBattle(state, from, to);
      turnLog.attacks++;
      if (r.captured) turnLog.captures++;
      return r;
    },
  };
}

function playProfile(factory, seed) {
  const policy = factory();
  const state = makeState(seed);
  const turns = [];
  let turn = 0;
  while (!G.checkWinner(state) && turn < 300) {
    turn++;
    const before = G.counts(state);
    const turnLog = { turn, beforeRed: before.red, beforeMaxEnemy: Math.max(before.green, before.yellow, before.blue, before.purple), attacks: 0, captures: 0 };
    try { policy(turnApiWithLog(state, G.HUMAN, turnLog)); } catch (_) {}
    const afterRed = G.counts(state);
    turnLog.afterRed = afterRed.red;
    if (!G.checkWinner(state)) G.reinforce(state, G.HUMAN);
    if (!G.checkWinner(state)) {
      const log = [];
      for (const bot of G.BOTS) {
        G.runBotTurn(state, bot, log);
        if (G.checkWinner(state)) break;
      }
    }
    turns.push(turnLog);
  }
  const winner = G.checkWinner(state);
  return { seed, won: winner === G.HUMAN, winner, turns, final: G.counts(state) };
}

function bucket(v, cuts) {
  for (const cut of cuts) if (v <= cut) return `<=${cut}`;
  return `>${cuts[cuts.length - 1]}`;
}

function summarize(records, title, getter, cuts) {
  const buckets = new Map();
  for (const r of records) {
    const key = bucket(getter(r), cuts);
    const cur = buckets.get(key) || { total: 0, wins: 0 };
    cur.total++;
    if (r.won) cur.wins++;
    buckets.set(key, cur);
  }
  console.log(`\n${title}`);
  for (const [key, v] of [...buckets.entries()].sort()) {
    console.log(`${key.padEnd(8)} ${String(v.wins).padStart(4)}/${String(v.total).padEnd(4)} ${(v.wins / v.total * 100).toFixed(1)}%`);
  }
}

function main() {
  const games = Number(process.argv[2]) || 1000;
  const seedBase = Number(process.argv[3]) || 1;
  const records = [];
  for (let i = 0; i < games; i++) records.push(playProfile(() => codex.makePressureStrategy(), seedBase + i));
  const wins = records.filter(r => r.won).length;
  console.log(`pressure ${wins}/${games} seeds ${seedBase}..${seedBase + games - 1}`);
  summarize(records, 'turns played', r => r.turns.length, [3, 5, 7, 9, 12, 20]);
  summarize(records, 'first-turn attacks', r => r.turns[0]?.attacks || 0, [0, 1, 2, 3, 5, 8, 13]);
  summarize(records, 'first-turn captures', r => r.turns[0]?.captures || 0, [0, 1, 2, 3, 5, 8]);
  summarize(records, 'total red attacks', r => r.turns.reduce((s, t) => s + t.attacks, 0), [3, 6, 10, 15, 25, 40, 70]);
  summarize(records, 'total red captures', r => r.turns.reduce((s, t) => s + t.captures, 0), [1, 3, 6, 10, 15, 20, 30]);

  const firstStops = records.map(r => ({ ...r, firstStopRed: r.turns[0]?.afterRed ?? 0 }));
  summarize(firstStops, 'after first red turn count', r => r.firstStopRed, [4, 6, 8, 10, 12, 15]);
}

if (require.main === module) main();

module.exports = { playProfile };
