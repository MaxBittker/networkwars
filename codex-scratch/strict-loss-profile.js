'use strict';

// Strict diagnostics for legal strategies. This file observes completed games
// only; it does not feed seed, RNG, benchmark-order, or outcome data back into
// production policies.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';

function counts(state) {
  const out = Object.fromEntries(FACTIONS.map(f => [f, 0]));
  for (const n of state.nodes) out[n.owner]++;
  return out;
}

function components(state, faction) {
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
        if (state.nodes[nb].owner === faction && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

function legalMoves(state) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      if (state.nodes[to].owner !== HUMAN) moves.push({ from: n.id, to });
    }
  }
  return moves;
}

function riskStats(state) {
  let allRisk = 0;
  let threatened = 0;
  let beatable = 0;
  let botMoves = 0;
  for (const n of state.nodes) {
    if (n.owner === HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      const target = state.nodes[to];
      if (target.owner !== HUMAN || n.strength <= target.strength) continue;
      const p = codex.captureProbability(n.strength, target.strength);
      allRisk += p;
      beatable++;
      if (p > 0.45) threatened++;
    }
    if (G.bestBotMove(state, n.owner)?.from === n.id) botMoves++;
  }
  return { allRisk, threatened, beatable, botMoves };
}

function features(state) {
  const c = counts(state);
  const redComps = components(state, HUMAN);
  const largest = redComps.reduce((best, comp) => Math.max(best, comp.length), 0);
  const redNodes = state.nodes.filter(n => n.owner === HUMAN);
  const border = redNodes.filter(n => state.adj[n.id].some(nb => state.nodes[nb].owner !== HUMAN));
  const risk = riskStats(state);
  const maxEnemy = Math.max(...BOTS.map(f => c[f]));
  const totalRedStrength = redNodes.reduce((sum, n) => sum + n.strength, 0);
  return {
    red: c.red,
    maxEnemy,
    gap: maxEnemy - c.red,
    largest,
    splits: Math.max(0, redComps.length - 1),
    legal: legalMoves(state).length,
    strength: totalRedStrength,
    strengthPerNode10: c.red ? Math.round((totalRedStrength / c.red) * 10) : 0,
    weakBorder: border.filter(n => n.strength <= 2).length,
    risk10: Math.round(risk.allRisk * 10),
    threatened: risk.threatened,
    beatable: risk.beatable,
    botMoves: risk.botMoves,
  };
}

function playTrace(factory, seed) {
  const policy = factory();
  const rng = G.makeRng(seed >>> 0);
  const board = G.buildBoard(rng);
  const state = { ...board, rng, policyRng: G.makeRng((seed ^ 0x9e3779b9) >>> 0) };
  const opening = features(state);
  const turns = [];

  for (let turn = 1; !G.checkWinner(state) && turn <= 300; turn++) {
    const before = features(state);
    try { policy(sim.turnApi(state, HUMAN)); } catch (_) {}
    const afterRed = features(state);
    if (!G.checkWinner(state)) G.reinforce(state, HUMAN);
    const afterReinforce = features(state);
    const botLog = [];
    if (!G.checkWinner(state)) {
      for (const bot of BOTS) {
        G.runBotTurn(state, bot, botLog);
        if (G.checkWinner(state)) break;
      }
    }
    const afterBots = features(state);
    turns.push({ turn, before, afterRed, afterReinforce, afterBots });
  }

  const winner = G.checkWinner(state);
  return { seed, winner, won: winner === HUMAN, opening, turns, final: features(state) };
}

function bucket(value, cuts) {
  for (const cut of cuts) if (value <= cut) return `<=${cut}`;
  return `>${cuts[cuts.length - 1]}`;
}

function summarize(records, label, getValue, cuts) {
  const rows = new Map();
  for (const r of records) {
    const key = bucket(getValue(r), cuts);
    const row = rows.get(key) || { total: 0, wins: 0 };
    row.total++;
    if (r.won) row.wins++;
    rows.set(key, row);
  }
  console.log(`\n${label}`);
  for (const [key, row] of [...rows.entries()].sort()) {
    console.log(`${key.padEnd(8)} ${String(row.wins).padStart(4)}/${String(row.total).padEnd(4)} ${(row.wins / row.total * 100).toFixed(1)}%`);
  }
}

function strategyFactory(name) {
  if (name === 'modal') return () => codex.codexModalOpeningGap;
  if (name === 'gap5') return () => codex.codexSafetyGap2Threat;
  if (name === 'gap2') return () => codex.codexSafetyGap2ThreatFast;
  if (name === 'k2') return () => codex.codexSafetyK2;
  if (name === 't36') return () => codex.codexSafetyThreat36;
  throw new Error(`unknown strategy: ${name}`);
}

function main() {
  const name = process.argv[2] || 'gap2';
  const games = Number(process.argv[3]) || 1000;
  const seedBase = Number(process.argv[4]) || 1;
  const records = [];
  const factory = strategyFactory(name);
  for (let i = 0; i < games; i++) records.push(playTrace(factory, seedBase + i));

  const wins = records.filter(r => r.won).length;
  console.log(`${name} ${wins}/${games} seeds ${seedBase}..${seedBase + games - 1}`);
  const losses = records.filter(r => !r.won);
  console.log(`loss winners: ${BOTS.map(f => `${f}:${losses.filter(r => r.winner === f).length}`).join(' ')}`);

  summarize(records, 'opening legal', r => r.opening.legal, [5, 10, 15, 20, 30, 40]);
  summarize(records, 'opening risk10', r => r.opening.risk10, [0, 3, 6, 10, 15, 25, 40]);
  summarize(records, 'turn2 red after bots', r => r.turns[0]?.afterBots.red ?? 0, [0, 2, 3, 4, 5, 6, 8, 10]);
  summarize(records, 'turn2 gap after bots', r => r.turns[0]?.afterBots.gap ?? 0, [-4, -2, 0, 2, 4, 6, 8]);
  summarize(records, 'turn2 risk10 after bots', r => r.turns[0]?.afterBots.risk10 ?? 0, [0, 3, 6, 10, 15, 25, 40]);
  summarize(records, 'turn3 red after bots', r => r.turns[1]?.afterBots.red ?? 0, [0, 3, 5, 7, 9, 12, 16, 20]);
  summarize(records, 'turn3 largest after bots', r => r.turns[1]?.afterBots.largest ?? 0, [0, 2, 4, 6, 8, 12, 16]);
  summarize(records, 'turn3 risk10 after bots', r => r.turns[1]?.afterBots.risk10 ?? 0, [0, 3, 6, 10, 15, 25, 40]);

  const lastBefore = losses.map(r => ({ ...r, last: r.turns[r.turns.length - 1]?.before || r.final }));
  summarize(lastBefore, 'loss final-before red', r => r.last.red, [0, 4, 8, 12, 16, 20, 23]);
  summarize(lastBefore, 'loss final-before gap', r => r.last.gap, [-6, -3, 0, 3, 6, 9, 12]);
}

if (require.main === module) main();
