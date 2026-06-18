'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const sim = require('./sim');
const { strategies } = require('./strategies');

const games = Number(process.argv[2]) || 1000;
const seedBase = Number(process.argv[3]) || 1;
const includeRl = !process.argv.includes('--no-rl');
const strict = process.argv.includes('--strict');

function pad(s, n) {
  return String(s).padEnd(n);
}

function padl(s, n) {
  return String(s).padStart(n);
}

function scoreJs(name, policy) {
  const result = sim.scorePolicy(policy, { games, seedBase });
  return {
    name,
    kind: 'js',
    games: result.games,
    wins: result.wins,
    winRate: result.winRate,
    avgTurnsToWin: result.avgTurnsToWin,
    avgGameLength: result.avgGameLength,
    msPerGame: result.msPerGame,
  };
}

function scorePythonRl(name, entry) {
  const python = path.join(__dirname, 'rl', '.venv', 'bin', 'python');
  const script = path.join(__dirname, entry.script || path.join('rl', 'evaluate.py'));
  const checkpoint = path.join(__dirname, entry.checkpoint);
  const args = [script, checkpoint, '--games', String(games), '--seed-base', String(seedBase), '--quiet'];
  if (entry.policyModule) args.push('--policy', entry.policyModule);
  if (entry.sample) args.push('--sample');

  const started = process.hrtime.bigint();
  const child = spawnSync(python, args, {
    cwd: __dirname,
    encoding: 'utf8',
    env: { ...process.env, PYTHONWARNINGS: 'ignore' },
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (child.error || child.status !== 0) {
    const detail = child.error ? child.error.message : child.stderr.trim();
    return {
      name,
      kind: entry.kind,
      error: detail || `exited ${child.status}`,
    };
  }

  const parsed = JSON.parse(child.stdout);
  return {
    name,
    kind: entry.kind,
    games: parsed.games,
    wins: parsed.wins,
    winRate: parsed.wins / parsed.games,
    avgTurnsToWin: parsed.avgTurnsToWin,
    avgGameLength: parsed.avgGameLength,
    msPerGame: elapsedMs / parsed.games,
  };
}

function scoreEntry(name, entry) {
  if (entry.kind === 'js') return scoreJs(name, entry.policy);
  if (entry.kind === 'python-rl') return scorePythonRl(name, entry);
  return { name, kind: entry.kind, error: `unknown strategy kind: ${entry.kind}` };
}

console.log(`\nNetwork Wars strategy comparison (${games} games, seeds ${seedBase}..${seedBase + games - 1}${strict ? ', strict no-rng/no-seed mode' : ''})\n`);
console.log(pad('strategy', 20), pad('kind', 10), padl('winrate', 9), padl('wins', 10), padl('avgTurns', 10), padl('avgLen', 8), padl('ms/game', 9));
console.log('-'.repeat(84));

const rows = [];
for (const [name, entry] of Object.entries(strategies)) {
  if (!includeRl && entry.kind === 'python-rl') continue;
  if (strict && entry.strict === false) continue;
  rows.push(scoreEntry(name, entry));
}

rows.sort((a, b) => {
  if (a.error && !b.error) return 1;
  if (!a.error && b.error) return -1;
  return (b.winRate ?? -1) - (a.winRate ?? -1);
});

for (const row of rows) {
  if (row.error) {
    console.log(pad(row.name, 20), pad(row.kind, 10), `ERROR ${row.error}`);
    continue;
  }

  console.log(
    pad(row.name, 20),
    pad(row.kind, 10),
    padl(`${(row.winRate * 100).toFixed(1)}%`, 9),
    padl(`${row.wins}/${row.games}`, 10),
    padl(row.avgTurnsToWin ? row.avgTurnsToWin.toFixed(2) : '-', 10),
    padl(row.avgGameLength ? row.avgGameLength.toFixed(1) : '-', 8),
    padl(row.msPerGame ? row.msPerGame.toFixed(2) : '-', 9),
  );
}

const best = rows.find(row => !row.error);
if (best) console.log(`\nBest: ${best.name} (${(best.winRate * 100).toFixed(1)}%)\n`);
