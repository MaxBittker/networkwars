#!/usr/bin/env python3
"""Static host for the browser game + the iOS board-import workflow.

The browser now runs the C engine itself (compiled to WASM in a Web Worker), so this
server holds NO game state and implements NO rules — it just serves public/ and the
two iOS-import endpoints below. (The old /api/game/* API that an earlier server-side
frontend spoke is gone; see git history if you need it.)

Run:  uv run python solver/server.py [--port 8080]
then open the printed http://127.0.0.1:<port>/ and play.

GET /grab pulls the CURRENT iOS-mirrored board (via iphone_data/play.py) into a new
in-browser game; GET /load imports a saved board JSON. Both are best-effort and only
relevant while iPhone Mirroring is live; normal offline play needs neither.
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

_next_id = [0]


def _new_id():
    _next_id[0] += 1
    return str(_next_id[0])


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
    return g


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

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in ('/', '/index.html'):
            try:
                self._send(200, open(INDEX, 'rb').read(), 'text/html')
            except FileNotFoundError:
                self._send(500, '<h1>public/index.html not found</h1>', 'text/html')
        elif path.endswith('.js') or path.endswith('.wasm'):
            # Serve the WASM engine + worker assets out of public/ (basename only, no
            # traversal). The browser runs the C engine in-process via these, so they
            # are what actually make play work.
            fp = os.path.join(ROOT, 'public', os.path.basename(path))
            ctype = 'application/wasm' if path.endswith('.wasm') else 'text/javascript'
            try:
                self._send(200, open(fp, 'rb').read(), ctype)
            except FileNotFoundError:
                self._send(404, {'error': f'no such asset: {path}'})
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
        else:
            self._send(404, {})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8080)
    a = ap.parse_args()
    print(f'Network Wars at http://127.0.0.1:{a.port}/  (Ctrl-C to stop)')
    ThreadingHTTPServer(('127.0.0.1', a.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
