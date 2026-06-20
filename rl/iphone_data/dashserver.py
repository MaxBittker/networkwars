#!/usr/bin/env python3
"""Lightweight PUBLISH-based dashboard for the C-UCT series driver.

Unlike nwserver.py (which computes neural moves itself), this server holds NO
model — series.py POSTs telemetry to /publish after each move and after each
game, and the dashboard at / renders it live (board, RED win expectation over
time, search-tree candidate bars, and the running series W-L tally).

Endpoints (127.0.0.1:PORT):
  POST /publish  body=<telemetry dict>  -> merges into state (move-level)
  POST /game     body={wins,losses,unknown,game_index,games,result}
  GET  /state    -> current telemetry JSON (dashboard polls this)
  GET  /healthz  -> "ok"
  GET  /         -> the dashboard HTML
Run:  dashserver.py [--port 8778]
"""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CAP = os.path.join(HERE, 'captures')

_TELE = {'move_num': 0, 'board': None, 'value': None, 'chosen': None,
         'chosen_end': False, 'top': [], 'total_visits': 0, 'counts': None,
         'phase': 'idle', 'history': [], 'shot': None,
         'series': {'wins': 0, 'losses': 0, 'unknown': 0, 'game_index': 0,
                    'games': 0, 'last_result': None}}


def publish_move(t):
    """Merge a per-move telemetry payload and append to the win-exp history."""
    _TELE['move_num'] += 1
    for k in ('board', 'counts', 'value', 'chosen', 'chosen_end', 'top',
              'total_visits', 'phase', 'shot'):
        if k in t:
            _TELE[k] = t[k]
    if t.get('value') is not None:
        _TELE['history'].append({'move_num': _TELE['move_num'], 'value': t['value'],
                                 'red': (t.get('counts') or {}).get('red'),
                                 'turn': t.get('turn')})
        _TELE['history'] = _TELE['history'][-400:]


DASHBOARD = r"""<!doctype html><html><head><meta charset=utf-8>
<title>Network Wars — pure C-UCT (b8k) series</title>
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
 .tally{display:flex;gap:22px;align-items:baseline}
 .tally .big{font-size:40px}
 .win{color:#39b54a}.loss{color:#e0473b}
</style></head><body>
<div class=wrap>
 <div>
  <div class=card><h2>Parsed board (what the AI sees)</h2><div id=board class=board></div>
   <div class=counts id=counts style=margin-top:10px></div>
   <div class=muted id=phase style=margin-top:6px></div>
  </div>
  <div class=card style=margin-top:18px><h2>Phone screenshot (ground truth)</h2>
   <img id=shot style="width:100%;border-radius:8px;display:block" />
   <div class=muted style=margin-top:6px>compare to the parsed board to spot stale frames vs bad reads</div>
  </div>
 </div>
 <div>
  <div class=card><h2>Series tally — pure C-UCT, 16000 sims</h2>
   <div class=tally><div class=big id=wr>—</div>
     <div><div id=tally class=muted></div><div id=cfg class=muted></div></div></div>
  </div>
  <div class=card style=margin-top:18px><h2>RED win expectation (this game)</h2>
   <div class=row><div class=big id=val>—</div><div class=muted id=valsub></div></div>
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
  let html='';const ch=s.chosen||{};
  for(let r=0;r<g.rows;r++)for(let c=0;c<g.cols;c++){
   const n=by[r+'_'+c];
   if(!n){html+='<div class="cell empty"></div>';continue}
   let cls='cell';if(ch&&n.id===ch.from)cls+=' src';if(ch&&n.id===ch.to)cls+=' dst';
   html+='<div class="'+cls+'" style="background:'+(COL[n.owner]||'#333')+'">'+(n.strength??'?')+'</div>';
  }
  bd.innerHTML=html;
  document.getElementById('counts').innerHTML=Object.entries(s.counts||{}).map(
   ([k,v])=>'<span style="color:'+(COL[k]||'#aaa')+'">'+k[0].toUpperCase()+' '+v+'</span>').join('');
  document.getElementById('phase').textContent='move #'+s.move_num+'  ·  '+(s.phase||'');
 }
 // refresh the phone screenshot when it changes (cache-bust by move_num)
 if(s.shot){
  const img=document.getElementById('shot');
  const url='/shot?v='+s.move_num;
  if(img.getAttribute('data-v')!==''+s.move_num){ img.src=url; img.setAttribute('data-v',''+s.move_num); }
 }
 // series tally
 const se=s.series||{};const dec=(se.wins||0)+(se.losses||0);
 const wr=document.getElementById('wr');
 wr.textContent=dec?((se.wins/dec*100).toFixed(0)+'%'):'—';
 wr.className='big '+(dec&&se.wins/dec>=0.5?'win':(dec?'loss':''));
 document.getElementById('tally').innerHTML=
   '<b class=win>'+(se.wins||0)+'W</b> · <b class=loss>'+(se.losses||0)+'L</b>'
   +(se.unknown?(' · '+se.unknown+'?'):'')+'  over '+dec+' decided';
 document.getElementById('cfg').textContent='game '+((se.game_index||0)+1)+'/'+(se.games||'?')
   +(se.last_result?('  · last: '+se.last_result):'');
 // win expectation
 const val=document.getElementById('val');
 if(s.value!=null){val.textContent=(s.value*100).toFixed(1)+'%';
   val.style.color=s.value>0.5?'#39b54a':(s.value<0.3?'#e0473b':'#d9b310');}
 const h=(s.history||[]);
 document.getElementById('valsub').textContent=h.length?('RED nodes: '+(s.counts?.red??'?')+'  ·  '+h.length+' moves'):'';
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
        elif self.path.startswith('/shot'):
            name = _TELE.get('shot')
            path = os.path.join(CAP, os.path.basename(name)) if name else None
            if path and os.path.exists(path):
                with open(path, 'rb') as f:
                    self._send(200, f.read(), 'image/png')
            else:
                self._send(404, b'', 'image/png')
        else:
            self._send(200, DASHBOARD, 'text/html')

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(n) or b'{}')
        if self.path == '/game':
            _TELE['series'].update(body)
            _TELE['history'] = []          # reset win-exp chart per game
        else:
            publish_move(body)
        self._send(200, '{"ok":true}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8778)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'dashserver ready on http://127.0.0.1:{args.port}  (dashboard at /)', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
