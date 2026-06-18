'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const G = require('./game');

const PORT = process.env.PORT || 3000;
const games = new Map();
let nextId = 1;

function newGame(seed) {
  const s = (seed === undefined || seed === null || Number.isNaN(+seed))
    ? (Math.floor(Math.random() * 0xffffffff))
    : (+seed >>> 0);
  const rng = G.makeRng(s);
  const board = G.buildBoard(rng);
  const id = String(nextId++);
  const state = {
    id, seed: s, rng,
    nodes: board.nodes, links: board.links, adj: board.adj,
    winner: null, over: false, redResigned: false,
  };
  games.set(id, state);
  return state;
}

// Public view: everything a UI or API client needs, nothing internal (rng/adj).
function view(state, log) {
  return {
    id: state.id,
    seed: state.seed,
    nodes: state.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, owner: n.owner, strength: n.strength })),
    links: state.links,
    counts: G.counts(state),
    winner: state.winner,
    over: state.over,
    redResigned: state.redResigned,
    youWon: state.winner === G.HUMAN,
    legalMoves: state.over ? [] : G.legalMoves(state, G.HUMAN),
    log: log || [],
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

const STATIC = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // --- static frontend ---
  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    fs.readFile(path.join(__dirname, 'public', file), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': type });
      res.end(buf);
    });
    return;
  }

  // --- API ---
  try {
    if (p === '/api/game' && req.method === 'POST') {
      const body = await readBody(req);
      const state = newGame(body.seed);
      return send(res, 200, view(state));
    }

    const m = p.match(/^\/api\/game\/([^/]+)(\/(attack|end-turn|surrender))?$/);
    if (m) {
      const state = games.get(m[1]);
      if (!state) return send(res, 404, { error: 'no such game' });
      const action = m[3];

      if (!action && req.method === 'GET') {
        return send(res, 200, view(state));
      }

      if (action === 'attack' && req.method === 'POST') {
        if (state.over) return send(res, 409, { error: 'game over' });
        const { from, to } = await readBody(req);
        const fromN = state.nodes[from], toN = state.nodes[to];
        if (!fromN || !toN) return send(res, 400, { error: 'bad node id' });
        if (fromN.owner !== G.HUMAN) return send(res, 400, { error: 'not your node' });
        if (fromN.strength <= 1) return send(res, 400, { error: 'node too weak to attack' });
        if (toN.owner === G.HUMAN) return send(res, 400, { error: 'cannot attack own node' });
        if (!state.adj[from].includes(to)) return send(res, 400, { error: 'nodes not linked' });
        const log = [G.resolveBattle(state, from, to)];
        const w = G.checkWinner(state);
        if (w) { state.winner = w; state.over = true; }
        return send(res, 200, view(state, log));
      }

      if (action === 'end-turn' && req.method === 'POST') {
        if (state.over) return send(res, 409, { error: 'game over' });
        const log = [];
        // RED's turn just ended -> RED reinforces first.
        const r = G.reinforce(state, G.HUMAN);
        if (r) log.push(r);
        let w = G.checkWinner(state);
        if (!w) {
          for (const bot of G.BOTS) {
            G.runBotTurn(state, bot, log);
            w = G.checkWinner(state);
            if (w) break;
          }
        }
        if (w) { state.winner = w; state.over = true; }
        return send(res, 200, view(state, log));
      }

      if (action === 'surrender' && req.method === 'POST') {
        state.over = true;
        state.redResigned = true;
        state.winner = null;
        return send(res, 200, view(state));
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Network Wars server on http://localhost:${PORT}`);
});
