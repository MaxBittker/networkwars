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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CAP = os.path.join(HERE, 'captures')

_TELE = {'move_num': 0, 'board': None, 'value': None, 'chosen': None,
         'chosen_end': False, 'top': [], 'total_visits': 0, 'counts': None,
         'phase': 'idle', 'history': [], 'shot': None,
         'stage': 'idle', 'stage_at': time.time(),
         'series': {'wins': 0, 'losses': 0, 'unknown': 0, 'game_index': 0,
                    'games': 0, 'last_result': None}}


def _crop_to_grid(path):
    """Crop the phone screenshot to just the board grid (using the published grid
    geometry, which is in full-res capture px) so it lines up with the parsed grid
    panel. Falls back to the full image if geometry is missing."""
    import io
    from PIL import Image
    im = Image.open(path).convert('RGB')
    g = (_TELE.get('board') or {}).get('grid') or {}
    if g.get('dx') and g.get('cols'):
        mx, my = g['dx'] * 0.7, g['dy'] * 0.7
        L = max(0, int(g['x0'] - mx)); T = max(0, int(g['y0'] - my))
        Rr = min(im.width, int(g['x0'] + (g['cols'] - 1) * g['dx'] + mx))
        B = min(im.height, int(g['y0'] + (g['rows'] - 1) * g['dy'] + my))
        if Rr > L and B > T:
            im = im.crop((L, T, Rr, B))
    buf = io.BytesIO(); im.save(buf, 'PNG')
    return buf.getvalue()


def _power(board):
    """Sum node strength per faction color (the 'power' of each color)."""
    pw = {}
    for n in (board or {}).get('nodes') or []:
        o = n.get('owner')
        if o:
            pw[o] = pw.get(o, 0) + (n.get('strength') or 0)
    return pw


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
                                 'power': _power(t.get('board')),
                                 'turn': t.get('turn')})
        _TELE['history'] = _TELE['history'][-400:]


DASHBOARD = r"""<!doctype html><html><head><meta charset=utf-8>
<title>Network Wars — C-UCT</title>
<style>
 body{margin:0;background:#d9d9d9;color:#1e1e1e;
   font:12px/1.35 "Segoe UI","Noto Sans","Helvetica Neue",Arial,sans-serif}
 .wrap{display:grid;grid-template-columns:440px 1fr;gap:10px;padding:10px;max-width:1180px}
 /* QGroupBox: 1px frame with the title notched onto the top border */
 .gb{position:relative;background:#efefef;border:1px solid #a0a0a0;border-radius:3px;
   margin-top:9px;padding:16px 10px 10px}
 .gb>.t{position:absolute;top:-8px;left:9px;padding:0 4px;background:#efefef;
   color:#3a3a3a;font-weight:600;font-size:11px}
 .board{display:grid;gap:3px}
 .cell{aspect-ratio:1;border:1px solid #888;display:flex;align-items:center;justify-content:center;
   font-weight:600;font-size:14px;color:#fff;position:relative;
   text-shadow:0 1px 1px rgba(0,0,0,.45)}
 .empty{background:#cfcfcf;border-color:#bcbcbc;box-shadow:inset 1px 1px 2px rgba(0,0,0,.12)}
 .src{outline:2px solid #1e1e1e;outline-offset:-2px}
 .dst{outline:2px dashed #1e1e1e;outline-offset:-2px}
 .bars div{margin:3px 0}
 .bar{height:18px;background:#c4c4c4;border:1px solid #9a9a9a;border-radius:2px;
   position:relative;overflow:hidden}
 .barfill{height:100%;background:linear-gradient(#5ba3d9,#3a86c8)}
 .barlbl{position:absolute;left:6px;top:2px;font-size:11px;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,.6);white-space:nowrap}
 .barnum{position:absolute;right:6px;top:2px;font-size:11px;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,.6)}
 .big{font-size:30px;font-weight:600;font-variant-numeric:tabular-nums}
 .row{display:flex;gap:12px;align-items:baseline}
 .muted{color:#5a5a5a}
 .counts span{display:inline-block;margin-right:10px;font-weight:600}
 .tally{display:flex;gap:18px;align-items:baseline}
 .tally .big{font-size:36px}
 .win{color:#2e8b30}.loss{color:#c0392b}
 img{border:1px solid #a0a0a0}
</style></head><body>
<div class=wrap>
 <div>
  <div class=gb><span class=t>Board</span>
   <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start">
    <div id=board class=board></div>
    <img id=shot style="width:100%;display:block" />
   </div>
   <div class=counts id=counts style=margin-top:8px></div>
   <div class=muted id=phase style=margin-top:4px></div>
  </div>
  <div class=gb><span class=t>Stage</span>
   <div class=row><div class=big id=stage style=font-size:20px>—</div>
     <div class=big id=stageT style="font-size:26px">—</div></div>
   <div class=muted id=stagehint style=margin-top:2px></div>
  </div>
  <div class=gb><span class=t>Series</span>
   <div class=tally><div class=big id=wr>—</div>
     <div><div id=tally class=muted></div><div id=cfg class=muted></div></div></div>
  </div>
 </div>
 <div>
  <div class=gb><span class=t>RED win %</span>
   <div class=row><div class=big id=val>—</div><div class=muted id=valsub></div></div>
   <div class=muted style="margin:4px 0" id=vallegend></div>
   <div id=chart></div>
  </div>
  <div class=gb><span class=t>Color power</span>
   <div class=row id=pwrlegend style=margin-bottom:6px></div>
   <div id=pwrchart></div>
  </div>
  <div class=gb><span class=t>Search tree</span>
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
 // driver stage + elapsed (so a stall is obvious)
 if(s.stage!==undefined){
  document.getElementById('stage').textContent=s.stage;
  const el=(s.now&&s.stage_at)?Math.max(0,s.now-s.stage_at):0;
  const st=document.getElementById('stageT');
  st.textContent=el.toFixed(0)+'s';
  st.style.color=el>60?'#e0473b':(el>25?'#d9b310':'#39b54a');
  document.getElementById('stagehint').textContent=el>60?'⚠ likely STUCK — check the phone / log':(el>25?'taking a while…':'');
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
 // win % — the single readout is the search's own estimate (MCTS backed-up Q of
 // the chosen move). AUC ~0.955 vs real outcomes; it falls out of the algorithm.
 const val=document.getElementById('val');
 const primary=s.value;
 if(primary!=null){val.textContent=(primary*100).toFixed(1)+'%';
   val.style.color=primary>0.5?'#39b54a':(primary<0.3?'#e0473b':'#d9b310');}
 const h=(s.history||[]);
 document.getElementById('valsub').textContent=
   'RED nodes: '+(s.counts?.red??'?')+'  ·  '+h.length+' moves';
 document.getElementById('vallegend').innerHTML=
   '<span style="color:#2a6db0">━ RED win% (MCTS)</span>';
 const sv=document.getElementById('chart');
 if(h.length>1){
  const W=700,H=140,n=h.length;
  const allv=h.map(d=>d.value).filter(v=>v!=null);
  let lo=Math.min(...allv),hi=Math.max(...allv);
  const pad=Math.max(0.04,(hi-lo)*0.25);lo=Math.max(0,lo-pad);hi=Math.min(1,hi+pad);
  const Y=v=>H-(v-lo)/((hi-lo)||1)*H;
  const pts=h.map((d,i)=>[i/(n-1)*W,Y(d.value)]);
  const line=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area='M'+pts[0][0].toFixed(1)+' '+H+' '+pts.map(p=>'L'+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ')+' L'+W+' '+H+' Z';
  const grid=v=>'<line x1="0" y1="'+Y(v).toFixed(1)+'" x2="'+W+'" y2="'+Y(v).toFixed(1)+'" stroke="#c4c4c4" stroke-dasharray="4"/><text x="4" y="'+(Y(v)-3).toFixed(1)+'" fill="#707070" font-size="11">'+(v*100).toFixed(0)+'%</text>';
  let gl='';[0.5,Math.round(lo*100)/100,Math.round(hi*100)/100].forEach(v=>{if(v>lo&&v<hi)gl+=grid(v)});
  sv.innerHTML='<svg width="100%" height="140" viewBox="0 0 700 140" preserveAspectRatio="none">'
   +gl+'<path d="'+area+'" fill="rgba(42,109,176,.10)"/>'
   +'<path d="'+line+'" fill="none" stroke="#2a6db0" stroke-width="2"/>'
   +pts.map(p=>'<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="2.5" fill="#2a6db0"/>').join('')
   +'</svg>';
 }
 // color power over time (stacked bar, one segment per faction per step)
 const pc=document.getElementById('pwrchart');
 const ph=h.filter(d=>d.power);
 if(ph.length>1){
  const W=700,H=140,n=ph.length;
  const cols=Object.keys(COL).filter(k=>ph.some(d=>(d.power[k]||0)>0));
  let hi=1;ph.forEach(d=>{let s=0;cols.forEach(k=>s+=d.power[k]||0);hi=Math.max(hi,s)});
  hi=Math.ceil(hi/10)*10;
  const bw=W/n,gap=n>120?0:Math.min(1,bw*0.15);
  let rects='';
  ph.forEach((d,i)=>{
   const x=i*bw;let acc=0;
   cols.forEach(k=>{
    const v=d.power[k]||0;if(!v)return;
    const hh=v/hi*H,y=H-acc-hh;acc+=hh;
    rects+='<rect x="'+x.toFixed(2)+'" y="'+y.toFixed(2)+'" width="'+(bw-gap).toFixed(2)+'" height="'+hh.toFixed(2)+'" fill="'+COL[k]+'"/>';
   });
  });
  const Y=v=>H-v/hi*H;
  const grid=v=>'<line x1="0" y1="'+Y(v).toFixed(1)+'" x2="'+W+'" y2="'+Y(v).toFixed(1)+'" stroke="#c4c4c4" stroke-dasharray="4"/><text x="4" y="'+(Y(v)-3).toFixed(1)+'" fill="#707070" font-size="11">'+v+'</text>';
  let gl='';[hi,Math.round(hi/2)].forEach(v=>{if(v>0)gl+=grid(v)});
  pc.innerHTML='<svg width="100%" height="140" viewBox="0 0 700 140" preserveAspectRatio="none">'+rects+gl+'</svg>';
  document.getElementById('pwrlegend').innerHTML=cols.map(k=>{
   const v=ph[ph.length-1].power[k]||0;
   return '<span style="color:'+COL[k]+';font-weight:700">'+k[0].toUpperCase()+' '+v+'</span>';
  }).join('');
 }
 // search tree bars
 const bars=document.getElementById('bars'),t=s.top||[];
 const mx=Math.max(1,...t.map(x=>x.visits));
 document.getElementById('treemeta').textContent=t.length?(s.total_visits+' visits'):'end turn';
 bars.innerHTML=t.map((x,i)=>{
  const w=(x.visits/mx*100).toFixed(1);
  const q=x.q==null?'':(x.q*100).toFixed(0)+'% Q';
  return '<div><div class=bar><div class=barfill style="width:'+w+'%;'+(i==0?'background:linear-gradient(#5dbf5f,#2e8b30)':'')+'"></div>'
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
            _TELE['now'] = time.time()      # so the client can compute stage elapsed
            self._send(200, json.dumps(_TELE, default=float))
        elif self.path.startswith('/shot'):
            name = _TELE.get('shot')
            path = os.path.join(CAP, os.path.basename(name)) if name else None
            if path and os.path.exists(path):
                self._send(200, _crop_to_grid(path), 'image/png')
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
        elif self.path == '/stage':
            _TELE['stage'] = body.get('stage', '?')
            _TELE['stage_at'] = time.time()
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
