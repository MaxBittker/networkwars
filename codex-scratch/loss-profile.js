'use strict';

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];

function components(state, faction) {
  const seen = new Set();
  const comps = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || seen.has(n.id)) continue;
    const comp = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const nb of state.adj[id]) {
        if (state.nodes[nb].owner === faction && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

function legalMoves(state) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== 'red' || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) if (state.nodes[to].owner !== 'red') moves.push({ from: n.id, to });
  }
  return moves;
}

function openingOkCount(state) {
  let ok = 0;
  for (const move of legalMoves(state)) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    if (codex.captureProbability(from.strength, to.strength) > 0.4) ok++;
  }
  return ok;
}

function features(state) {
  const c = G.counts(state);
  const redComps = components(state, 'red');
  const largestRed = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const enemyCounts = BOTS.map(f => c[f]).sort((a, b) => b - a);
  const redStrengths = state.nodes.filter(n => n.owner === 'red').map(n => n.strength);
  const maxEnemy = enemyCounts[0];
  return {
    red: c.red,
    maxEnemy,
    gap: maxEnemy - c.red,
    largestRed,
    redComps: redComps.length,
    redTotalStrength: redStrengths.reduce((a, b) => a + b, 0),
    redMaxStrength: redStrengths.reduce((a, b) => Math.max(a, b), 0),
    legal: legalMoves(state).length,
  };
}

function playTrace(policyFactory, seed) {
  const policy = policyFactory();
  const rng = G.makeRng(seed >>> 0);
  const board = G.buildBoard(rng);
  const state = { ...board, rng, policyRng: G.makeRng((seed ^ 0x9e3779b9) >>> 0) };
  const opening = { ...features(state), openingOk: openingOkCount(state) };
  const turns = [];
  let turn = 0;
  while (!G.checkWinner(state) && turn < 300) {
    turn++;
    const before = features(state);
    try { policy(sim.turnApi(state, G.HUMAN)); } catch (_) {}
    const afterRed = features(state);
    if (!G.checkWinner(state)) G.reinforce(state, G.HUMAN);
    const afterReinforce = features(state);
    const log = [];
    if (!G.checkWinner(state)) {
      for (const bot of G.BOTS) {
        G.runBotTurn(state, bot, log);
        if (G.checkWinner(state)) break;
      }
    }
    const afterBots = features(state);
    turns.push({ turn, before, afterRed, afterReinforce, afterBots });
  }
  const winner = G.checkWinner(state);
  return { seed, won: winner === 'red', winner, opening, turns, final: features(state) };
}

function bucket(value, cuts) {
  for (const cut of cuts) if (value <= cut) return `<=${cut}`;
  return `>${cuts[cuts.length - 1]}`;
}

function summarize(records, label, getter, cuts) {
  const buckets = new Map();
  for (const r of records) {
    const key = bucket(getter(r), cuts);
    const cur = buckets.get(key) || { total: 0, wins: 0 };
    cur.total++;
    if (r.won) cur.wins++;
    buckets.set(key, cur);
  }
  console.log(`\n${label}`);
  for (const [key, val] of [...buckets.entries()].sort()) {
    console.log(`${key.padEnd(8)} ${String(val.wins).padStart(4)}/${String(val.total).padEnd(4)} ${(val.wins / val.total * 100).toFixed(1)}%`);
  }
}

function main() {
  const games = Number(process.argv[2]) || 1000;
  const seedBase = Number(process.argv[3]) || 1;
  const records = [];
  for (let i = 0; i < games; i++) {
    records.push(playTrace(() => codex.makePressureStrategy(), seedBase + i));
  }
  const wins = records.filter(r => r.won).length;
  console.log(`codexPressure ${wins}/${games} seeds ${seedBase}..${seedBase + games - 1}`);

  summarize(records, 'openingOk', r => r.opening.openingOk, [4, 8, 12, 16, 20]);
  summarize(records, 'opening redMaxStrength', r => r.opening.redMaxStrength, [1, 2, 3, 4, 5]);
  summarize(records, 'opening largestRed', r => r.opening.largestRed, [1, 2, 3, 4, 5, 6]);

  const losses = records.filter(r => !r.won);
  console.log(`\nLoss winners: ${BOTS.map(f => `${f}:${losses.filter(r => r.winner === f).length}`).join(' ')}`);
  const lastBefore = losses.map(r => ({ ...r, last: r.turns[r.turns.length - 1]?.before || r.final }));
  summarize(lastBefore, 'loss last-before red count', r => r.last.red, [0, 4, 8, 12, 16, 20, 23]);
  summarize(lastBefore, 'loss last-before gap', r => r.last.gap, [-6, -3, 0, 3, 6, 9, 12]);
  summarize(lastBefore, 'loss last-before legal moves', r => r.last.legal, [0, 2, 5, 10, 20, 40]);
}

if (require.main === module) main();

module.exports = { playTrace, features };
