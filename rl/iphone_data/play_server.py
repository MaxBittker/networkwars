#!/usr/bin/env python3
"""Local server for play_sim.html with a live /grab endpoint.

Serves rl/play_sim.html over http (so fetch works) and exposes GET /grab, which
captures + parses the CURRENT iOS phone board and returns it as JSON. The page's
"Sync from phone" button calls /grab, so you can pull the live iOS position into
the sim with one click — no manual grab_board.py + regenerate + refresh.

Run while iPhone Mirroring is live:
    python iphone_data/play_server.py
then open the printed http://127.0.0.1 URL (NOT the file://).
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import play as PL

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(os.path.dirname(HERE), 'play_sim.html')   # rl/play_sim.html
PORT = 8799


def grab_board():
    """Capture + parse the live phone board; None if no clean parse."""
    PL.place()
    st, fp = PL.capture_state('sync_grab', max_tries=25)
    if fp is None or st in ('over', None):
        return None
    return {
        'nodes': [{'id': n['id'], 'x': n['col'], 'y': n['row'], 'owner': n['owner'],
                   'strength': n['strength'] if n['strength'] is not None else 1}
                  for n in st['nodes']],
        'counts': dict(st['counts']),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='application/json'):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in ('/', '/index.html', '/play_sim.html'):
            try:
                self._send(200, open(HTML, 'rb').read(), 'text/html')
            except FileNotFoundError:
                self._send(500, '<h1>Run: python gen_play_html.py first.</h1>', 'text/html')
        elif path == '/grab':
            try:
                board = grab_board()
            except Exception as e:
                self._send(503, json.dumps({'error': f'capture error: {e}'}))
                return
            if board is None:
                self._send(503, json.dumps(
                    {'error': 'no clean board parse (iPhone in Use? lock the phone, then retry)'}))
            else:
                print(f"  /grab -> counts {board['counts']}")
                self._send(200, json.dumps(board))
        else:
            self._send(404, '{}')


def main():
    url = f'http://127.0.0.1:{PORT}/'
    print(f'play_sim served at {url}')
    print('  open that URL, then click "Sync from phone" to pull the live iOS board.')
    print('  (keep iPhone Mirroring live; Ctrl-C to stop)')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
