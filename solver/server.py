#!/usr/bin/env python3
"""HTTP server for the browser game — the same C engine the solver uses.

Implements the /api/game/* API that public/index.html speaks, backed by the C
engine via fastnw (board-gen, the four bots, the power-ratio battle, reinforcement
all run in C). No game logic lives in the browser or here; this just marshals JSON.

Run:  uv run python solver/server.py [--port 8080]
then open the printed http://127.0.0.1:<port>/ and play.

GET /grab pulls the CURRENT iOS-mirrored board (via iphone_data/play.py) into a new
in-browser game — the "grab phone board -> play in sim" workflow. It is best-effort
and only works while iPhone Mirroring is live; normal play needs none of it.
"""
import argparse
import json
import os
import random
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

import fastnw
from fastnw import FACTIONS

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(ROOT, 'public', 'index.html')

GAMES = {}
_next_id = [0]


def _new_id():
    _next_id[0] += 1
    return str(_next_id[0])


def _select(g):
    """Make the C engine's global topology match game g (before any mutation)."""
    fastnw.set_topology_csr(len(g['owner']), g['adj'])


def _update_winner(g):
    c = fastnw.counts(g['owner'])
    w = -1
    for f in range(5):
        if c[f] >= 24:
            w = f
    alive = [f for f in range(5) if c[f] > 0]
    if len(alive) == 1:
        w = alive[0]
    if w >= 0:
        g['over'] = True
        g['winner'] = FACTIONS[w]
        g['youWon'] = (w == 0)


def view(g):
    owner, strength = g['owner'], g['strength']
    n = len(owner)
    nodes = [{'id': i, 'x': int(g['x'][i]), 'y': int(g['y'][i]),
              'owner': FACTIONS[int(owner[i])], 'strength': int(strength[i])}
             for i in range(n)]
    c = fastnw.counts(owner)
    counts = {FACTIONS[f]: c[f] for f in range(5)}
    legal = [{'from': a, 'to': b} for (a, b) in fastnw.legal_moves(owner, strength, g['adj'])]
    return {'id': g['id'], 'nodes': nodes, 'links': g['links'], 'counts': counts,
            'turn': g['turn'], 'legalMoves': legal, 'over': g['over'],
            'youWon': g['youWon'], 'redResigned': g['redResigned'],
            'winner': g['winner']}


def new_game(seed=None):
    if seed is None:
        seed = random.randrange(1, 2 ** 31)
    d = fastnw.new_game(seed)
    g = {'id': _new_id(), 'owner': d['owner'], 'strength': d['strength'],
         'x': d['x'], 'y': d['y'], 'adj': d['adj'], 'links': d['links'],
         'mb': d['mb'], 'turn': 1, 'over': False, 'youWon': False,
         'redResigned': False, 'winner': None, 'seed': seed}
    GAMES[g['id']] = g
    return g


def game_from_board(nodes, mb_seed=None):
    """Start a game from an externally-parsed board (list of {id,x,y,owner,strength}).
    Adjacency = 8-connectivity over (x,y), matching the iOS-parse path."""
    n = len(nodes)
    owner = np.zeros(n, dtype=np.int32)
    strength = np.zeros(n, dtype=np.int32)
    x = np.zeros(n, dtype=np.int32)
    y = np.zeros(n, dtype=np.int32)
    for nd in nodes:
        i = nd['id']
        owner[i] = fastnw.FIDX[nd['owner']]
        strength[i] = nd['strength']
        x[i] = nd['x']; y[i] = nd['y']
    adj = [[] for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            if abs(int(x[i]) - int(x[j])) <= 1 and abs(int(y[i]) - int(y[j])) <= 1:
                adj[i].append(j); adj[j].append(i)
    fastnw.set_topology_csr(n, adj)
    links = fastnw.get_links()
    g = {'id': _new_id(), 'owner': owner, 'strength': strength, 'x': x, 'y': y,
         'adj': adj, 'links': links,
         'mb': (mb_seed if mb_seed is not None else random.randrange(1, 2 ** 31)),
         'turn': 1, 'over': False, 'youWon': False, 'redResigned': False,
         'winner': None, 'seed': None}
    GAMES[g['id']] = g
    return g


def do_attack(g, frm, to):
    _select(g)
    fastnw.use_mb32(g['mb'])
    flips, meta = fastnw.attack_logged(g['owner'], g['strength'], frm, to)
    g['mb'] = fastnw.get_mb32()
    _update_winner(g)
    log = [{'type': 'attack', 'attacker': 'red', 'from': frm, 'to': to,
            'captured': meta['captured'], 'fromStart': meta['fromStart'],
            'toStart': meta['toStart'], 'flips': flips,
            'fromStrength': meta['fromStrength'], 'toStrength': meta['toStrength']}]
    out = view(g); out['log'] = log
    return out


def do_end_turn(g):
    _select(g)
    fastnw.use_mb32(g['mb'])
    before = g['owner'].copy()
    fastnw.end_turn(g['owner'], g['strength'])
    g['mb'] = fastnw.get_mb32()
    g['turn'] += 1
    _update_winner(g)
    changed = int((g['owner'] != before).sum())   # nodes that changed hands during bots
    out = view(g)
    out['log'] = [{'type': 'attack', 'captured': True} for _ in range(changed)]
    return out


def do_search(g, sims=5000, c_puct=2.5, nroll=1, sim_seed=0x12345678):
    """Run the SAME C-UCT MCTS the sim/phone driver uses, for RED's current turn.

    Returns the search's win expectation (backed-up Q of the best move) and the
    ranked top moves. Rolls out on the private sim stream (never touches g['mb'],
    the real game dice), so calling this can't leak future dice into play."""
    _select(g)
    fastnw.use_sim(sim_seed)
    acts, visits, q = fastnw.uct_search(g['owner'], g['strength'], g['turn'],
                                        sims, c_puct, nroll, return_q=True)
    if len(acts) == 0:
        return {'winexp': None, 'visits': 0, 'top': [], 'best': None}
    order = sorted(range(len(acts)), key=lambda k: -int(visits[k]))
    tv = int(visits.sum())
    top = []
    for k in order:
        a = int(acts[k])
        frm, to = (None, None) if a == -1 else (a >> 8, a & 0xFF)
        top.append({'action': a, 'from': frm, 'to': to, 'visits': int(visits[k]),
                    'frac': (int(visits[k]) / tv) if tv else 0.0, 'q': float(q[k])})
    best = top[0]
    return {'winexp': best['q'], 'visits': tv, 'top': top[:8], 'best': best}


def do_surrender(g):
    g['over'] = True
    g['redResigned'] = True
    g['youWon'] = False
    out = view(g); out['log'] = []
    return out


def grab_board():
    """Capture + parse the live iOS board (best-effort; needs iPhone Mirroring)."""
    import sys
    sys.path.insert(0, os.path.join(HERE, 'iphone_data'))
    import play as PL
    PL.place()
    st, fp = PL.capture_state('sync_grab', max_tries=25)
    if fp is None or st in ('over', None):
        return None
    return [{'id': n['id'], 'x': n['col'], 'y': n['row'], 'owner': n['owner'],
             'strength': n['strength'] if n['strength'] is not None else 1}
            for n in st['nodes']]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b'{}')
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in ('/', '/index.html'):
            try:
                self._send(200, open(INDEX, 'rb').read(), 'text/html')
            except FileNotFoundError:
                self._send(500, '<h1>public/index.html not found</h1>', 'text/html')
        elif path == '/grab':
            try:
                board = grab_board()
            except Exception as e:
                self._send(503, {'error': f'capture error: {e}'}); return
            if not board:
                self._send(503, {'error': 'no clean board parse (lock the phone, retry)'})
            else:
                self._send(200, view(game_from_board(board)))
        elif path == '/load':
            # Load a saved board JSON ({nodes:[{id,x,y,owner,strength}]}) into a new
            # game — e.g. a recorded position from a live game's trajectory. The file
            # is a basename resolved under iphone_data/ (no path traversal).
            from urllib.parse import parse_qs, urlparse
            name = (parse_qs(urlparse(self.path).query).get('file') or [''])[0]
            name = os.path.basename(name)
            fp = os.path.join(HERE, 'iphone_data', name)
            if not name or not os.path.exists(fp):
                self._send(404, {'error': f'no such board file: {name}'}); return
            try:
                board = json.load(open(fp))['nodes']
                self._send(200, view(game_from_board(board)))
            except Exception as e:
                self._send(500, {'error': f'load error: {e}'})
        elif path.startswith('/api/game/'):
            gid = path[len('/api/game/'):]
            g = GAMES.get(gid)
            self._send(200 if g else 404, view(g) if g else {'error': 'no such game'})
        else:
            self._send(404, {})

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/game':
            self._send(200, view(new_game(self._body().get('seed')))); return
        if path.startswith('/api/game/'):
            rest = path[len('/api/game/'):]
            gid, _, action = rest.partition('/')
            g = GAMES.get(gid)
            if not g:
                self._send(404, {'error': 'no such game'}); return
            if action == 'attack':
                b = self._body()
                self._send(200, do_attack(g, int(b['from']), int(b['to']))); return
            if action == 'end-turn':
                self._send(200, do_end_turn(g)); return
            if action == 'search':
                b = self._body()
                self._send(200, do_search(g, int(b.get('sims', 6000)))); return
            if action == 'surrender':
                self._send(200, do_surrender(g)); return
        self._send(404, {})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8080)
    a = ap.parse_args()
    print(f'Network Wars at http://127.0.0.1:{a.port}/  (Ctrl-C to stop)')
    ThreadingHTTPServer(('127.0.0.1', a.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
