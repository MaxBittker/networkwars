#!/usr/bin/env python3
"""Persistent neural-MCTS inference server + live dashboard for the iOS driver.

Loads sl_cnn.pt ONCE and stays resident, so play.py no longer pays ~1.3s of
torch-import + checkpoint-reload on every move (the search itself is ~40ms).

Endpoints (127.0.0.1:PORT):
  POST /move    body={"board":<parsed state>,"sims":N,"turns":T}
                -> {"action":"attack","from":..,"to":..,"fromPx":..,"toPx":..} | {"action":"stop"}
                Also records telemetry for the dashboard.
  GET  /state   -> latest telemetry + win-rate history (JSON), for the dashboard
  GET  /healthz -> "ok" once the model is loaded
  GET  /        -> the live dashboard (self-contained HTML; polls /state)

Run:  nwserver.py [--port 8777] [--checkpoint sl_cnn.pt] [--policy policy_cnn]
"""
import argparse
import importlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RL_DIR)

import torch

import network_wars as nw
from network_wars import HUMAN, DIRS, END_TURN, GRID_COLS, State, Node as GNode
import mcts as M

_EV = None                 # Evaluator (model loaded once)
_LOCK = threading.Lock()   # serialize searches (single torch model)
_TELE = {'move_num': 0, 'board': None, 'value': None, 'chosen': None,
         'top': [], 'total_visits': 0, 'counts': None, 'phase': 'idle',
         'history': []}     # history: [{move_num, value, red, turn}]


def build_state(js):
    nodes = [GNode(n['id'], n['col'], n['row'], n['owner'], n['strength'])
             for n in js['nodes']]
    n = len(nodes)
    adj = [[] for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            if abs(nodes[i].x - nodes[j].x) <= 1 and abs(nodes[i].y - nodes[j].y) <= 1:
                adj[i].append(j)
                adj[j].append(i)
    s = State()
    s.nodes, s.adj, s.links = nodes, adj, []
    s.rng = s.policy_rng = None
    return s


def decode(action, c2id):
    """action index -> (from_id, to_id) or (None, None) for END_TURN."""
    if action == END_TURN:
        return None, None
    cell, d = divmod(int(action), len(DIRS))
    y, x = divmod(cell, GRID_COLS)
    dy, dx = DIRS[d]
    return c2id.get((y, x)), c2id.get((y + dy, x + dx))


def run_move(js, sims, turns):
    state = build_state(js)
    # guard: a node outside the model's fixed grid (bad parse) would overflow the
    # observation — bail to END TURN rather than crash.
    if any(not (0 <= n.y < nw.GRID_ROWS and 0 <= n.x < GRID_COLS) for n in state.nodes):
        return {'action': 'stop', 'error': 'board out of grid'}
    c2id = M.coord_map(state)
    px = {n['id']: [n['px'], n['py']] for n in js['nodes']}
    nodes = {n['id']: n for n in js['nodes']}

    legal = M.legal_action_indices(state, c2id)
    if len(legal) == 1:                       # only END_TURN
        root, value = None, None
        chosen = END_TURN
    else:
        with _LOCK:
            root = M.mcts_search(state, turns, _EV, c2id, sims, 1.5)
        value = float(root.v)
        chosen = M.best_action(root, legal, by='visits')

    # ---- telemetry: search-tree summary (visits/Q/prior per candidate) -------
    top = []
    if root is not None:
        total = sum(root.N.get(a, 0) for a in legal) or 1
        for a in legal:
            v = root.N.get(a, 0)
            if a == END_TURN:
                frm = to = None
                label = 'END TURN'
                fo = to_owner = None
            else:
                frm, to = decode(a, c2id)
                fo = nodes[frm]['owner'] if frm is not None else None
                to_owner = nodes[to]['owner'] if to is not None else None
                label = (f"{fo[0].upper()}{nodes[frm]['strength']}→{to_owner[0].upper()}"
                         f"{nodes[to]['strength']}") if frm is not None and to is not None else '?'
            q = (root.W.get(a, 0.0) / v) if v > 0 else None
            top.append({'action': int(a), 'from': frm, 'to': to, 'label': label,
                        'from_owner': fo, 'to_owner': to_owner,
                        'visits': int(v), 'frac': v / total,
                        'q': (float(q) if q is not None else None),
                        'prior': float(root.P.get(a, 0.0))})
        top.sort(key=lambda z: -z['visits'])
        top = top[:14]

    cf, ct = decode(chosen, c2id)
    counts = js.get('counts', {})
    _TELE.update({
        'move_num': _TELE['move_num'] + 1,
        'board': {'grid': js['grid'], 'nodes': js['nodes']},
        'value': value, 'counts': counts,
        'chosen': None if chosen == END_TURN else {'from': cf, 'to': ct},
        'chosen_end': chosen == END_TURN,
        'top': top, 'total_visits': sum(t['visits'] for t in top),
        'phase': 'end-turn' if chosen == END_TURN else 'attack',
    })
    if value is not None:
        _TELE['history'].append({'move_num': _TELE['move_num'], 'value': value,
                                 'red': counts.get('red'), 'turn': turns})
        _TELE['history'] = _TELE['history'][-400:]

    if chosen == END_TURN:
        return {'action': 'stop'}
    return {'action': 'attack', 'from': cf, 'to': ct,
            'fromPx': px[cf], 'toPx': px[ct]}


DASHBOARD = r"""<!doctype html><html><head><meta charset=utf-8>
<title>Network Wars — neural MCTS</title>
<style>
 body{margin:0;background:#0c0f17;color:#dce3f0;font:13px/1.4 -apple-system,Menlo,monospace}
 h2{font-size:13px;margin:0 0 8px;color:#8aa0c8;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
 .wrap{display:grid;grid-template-columns:340px 1fr;gap:18px;padding:18px;max-width:1100px}
 .card{background:#141926;border:1px solid #222a3d;border-radius:10px;padding:14px}
 .board{display:grid;gap:5px}
 .cell{aspect-ratio:1;border-radius:8px;display:flex;align-items:center;justify-content:center;
   font-weight:700;font-size:15px;color:#fff;position:relative;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
 .empty{background:#0e1220;box-shadow:none}
 .src{outline:3px solid #fff;outline-offset:-3px}
 .dst{outline:3px dashed #fff;outline-offset:-3px}
 .bars div{margin:3px 0}
 .bar{height:20px;border-radius:4px;background:#2a3550;position:relative;overflow:hidden}
 .barfill{height:100%;background:linear-gradient(90deg,#3b6fe0,#6f9bff)}
 .barlbl{position:absolute;left:7px;top:2px;font-size:11px;color:#fff;text-shadow:0 1px 2px #000;white-space:nowrap}
 .barnum{position:absolute;right:7px;top:2px;font-size:11px;color:#cfe}
 .big{font-size:34px;font-weight:700}
 .row{display:flex;gap:14px;align-items:baseline}
 .muted{color:#6b7a99}
 .counts span{display:inline-block;margin-right:10px;font-weight:700}
</style></head><body>
<div class=wrap>
 <div>
  <div class=card><h2>Board — model's view</h2><div id=board class=board></div>
   <div class=counts id=counts style=margin-top:10px></div>
   <div class=muted id=phase style=margin-top:6px></div>
  </div>
 </div>
 <div>
  <div class=card><h2>Estimated win rate over time</h2>
   <div class=row><div class=big id=wr>—</div><div class=muted id=wrsub></div></div>
   <div id=chart></div>
  </div>
  <div class=card style=margin-top:18px><h2>Search tree — candidate moves (visits)</h2>
   <div class=muted id=treemeta style=margin-bottom:8px></div>
   <div class=bars id=bars></div>
  </div>
 </div>
</div>
<script>
const COL={red:'#e0473b',green:'#39b54a',yellow:'#d9b310',blue:'#3b82e0',purple:'#9c4ddb'};
function cellKey(n){return n.row+'_'+n.col}
async function tick(){
 let s; try{s=await (await fetch('/state',{cache:'no-store'})).json()}catch(e){return}
 if(s.board){
  const g=s.board.grid, by={};s.board.nodes.forEach(n=>by[cellKey(n)]=n);
  const bd=document.getElementById('board');
  bd.style.gridTemplateColumns='repeat('+g.cols+',1fr)';
  let html='';
  const ch=s.chosen||{};
  for(let r=0;r<g.rows;r++)for(let c=0;c<g.cols;c++){
   const n=by[r+'_'+c];
   if(!n){html+='<div class="cell empty"></div>';continue}
   let cls='cell';if(n.id===ch.from)cls+=' src';if(n.id===ch.to)cls+=' dst';
   html+='<div class="'+cls+'" style="background:'+(COL[n.owner]||'#333')+'">'+(n.strength??'?')+'</div>';
  }
  bd.innerHTML=html;
  document.getElementById('counts').innerHTML=Object.entries(s.counts||{}).map(
   ([k,v])=>'<span style="color:'+(COL[k]||'#aaa')+'">'+k[0].toUpperCase()+' '+v+'</span>').join('');
  document.getElementById('phase').textContent='move #'+s.move_num+'  ·  '+(s.phase||'');
 }
 // win rate
 const wr=document.getElementById('wr');
 if(s.value!=null){wr.textContent=(s.value*100).toFixed(1)+'%';
   wr.style.color = s.value>0.5?'#39b54a':(s.value<0.3?'#e0473b':'#d9b310');}
 const h=(s.history||[]);
 document.getElementById('wrsub').textContent=h.length?('RED nodes: '+(s.counts?.red??'?')+'  ·  '+h.length+' decisions'):'';
 const sv=document.getElementById('chart');
 if(h.length>1){
  const W=700,H=140,n=h.length,vals=h.map(d=>d.value);
  let lo=Math.min(...vals),hi=Math.max(...vals);
  const pad=Math.max(0.04,(hi-lo)*0.25);lo=Math.max(0,lo-pad);hi=Math.min(1,hi+pad);
  const Y=v=>H-(v-lo)/((hi-lo)||1)*H;
  const pts=h.map((d,i)=>[i/(n-1)*W, Y(d.value)]);
  const line=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area='M'+pts[0][0].toFixed(1)+' '+H+' '+pts.map(p=>'L'+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ')+' L'+W+' '+H+' Z';
  const grid=v=>'<line x1="0" y1="'+Y(v).toFixed(1)+'" x2="'+W+'" y2="'+Y(v).toFixed(1)+'" stroke="#2a3550" stroke-dasharray="4"/><text x="4" y="'+(Y(v)-3).toFixed(1)+'" fill="#6b7a99" font-size="11">'+(v*100).toFixed(0)+'%</text>';
  let gl='';[0.5,Math.round(lo*100)/100,Math.round(hi*100)/100].forEach(v=>{if(v>lo&&v<hi)gl+=grid(v)});
  // set innerHTML on a DIV wrapper (not the <svg>) so children get the SVG namespace
  sv.innerHTML='<svg width="100%" height="140" viewBox="0 0 700 140" preserveAspectRatio="none">'
   +gl+'<path d="'+area+'" fill="rgba(111,155,255,.13)"/>'
   +'<path d="'+line+'" fill="none" stroke="#6f9bff" stroke-width="2"/>'
   +pts.map(p=>'<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.5" fill="#6f9bff"/>').join('')
   +'</svg>';
 }
 // search tree bars
 const bars=document.getElementById('bars'),t=s.top||[];
 const mx=Math.max(1,...t.map(x=>x.visits));
 document.getElementById('treemeta').textContent=t.length?('total visits: '+s.total_visits+'  (chosen = top bar)'):'(end turn — no search)';
 bars.innerHTML=t.map((x,i)=>{
  const w=(x.visits/mx*100).toFixed(1);
  const q=x.q==null?'':(x.q*100).toFixed(0)+'% Q';
  const col=x.from_owner?COL[x.from_owner]:'#888';
  return '<div><div class=bar><div class=barfill style="width:'+w+'%;'+(i==0?'background:linear-gradient(90deg,#39b54a,#7fe08a)':'')+'"></div>'
   +'<span class=barlbl>'+x.label+'</span><span class=barnum>'+x.visits+'  '+q+'</span></div></div>';
 }).join('');
}
setInterval(tick,400);tick();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype='application/json'):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == '/healthz':
            self._send(200, 'ok', 'text/plain')
        elif self.path.startswith('/state'):
            self._send(200, json.dumps(_TELE, default=float))
        else:
            self._send(200, DASHBOARD, 'text/html')

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        req = json.loads(self.rfile.read(n) or b'{}')
        try:
            mv = run_move(req['board'], int(req.get('sims', 100)), int(req.get('turns', 1)))
            self._send(200, json.dumps(mv))
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send(500, json.dumps({'action': 'stop', 'error': str(e)}))


def main():
    global _EV
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8777)
    ap.add_argument('--checkpoint', default=os.path.join(RL_DIR, 'sl_cnn.pt'))
    ap.add_argument('--policy', default='policy_cnn')
    args = ap.parse_args()

    from evaluate import _EnvShim
    policy = importlib.import_module(args.policy).Policy(_EnvShim(nw.OBS_DIM))
    policy.load_state_dict(torch.load(args.checkpoint, map_location='cpu'))
    policy.eval()
    _EV = M.Evaluator(policy)

    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'nwserver ready on http://127.0.0.1:{args.port}  (dashboard at /)', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
