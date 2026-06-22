#!/usr/bin/env python3
"""Generate a standalone, playable HTML of the REAL sim engine (game.js).

You play RED against the 4 sim bots (bestBotMove + reinforce) — bit-identical to
what `game.js` runs, so you can subjectively judge how the sim bots behave/feel vs
the real iOS opponents we've been comparing them to. game.js is inlined verbatim
behind a `module` shim, so this stays faithful: re-run this script to regenerate
after any game.js change.

Output: rl/play_sim.html  (open in any browser; no server needed)
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME_JS = os.path.join(ROOT, 'game.js')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'play_sim.html')

UI = r"""
const NW = module.exports;
const COLORS = {red:'#e74c3c',green:'#27ae60',yellow:'#f1c40f',blue:'#3498db',purple:'#9b59b6'};
const COLS = NW.GRID_COLS, ROWS = NW.GRID_ROWS, WIN = NW.WIN_NODES;
let state, rng, sel=null, over=null, logLines=[], lastChanged=new Set(), seed=1;
let animating=false, hl=null, banner='';      // hl = {from,to,result} battle being shown
let SPEED = 420;                                // ms per battle step (from the control)
const sleep = ms => new Promise(r=>setTimeout(r, ms));

function newGame(s){
  seed = (s|0) || (Math.floor(Math.random()*1e9));
  rng = NW.makeRng(seed);
  state = NW.buildBoard(rng);
  state.rng = rng;          // resolveBattle dice continue the same stream
  sel=null; over=null; logLines=[]; lastChanged=new Set(); hl=null; banner=''; animating=false;
  log(`— new game (seed ${seed}). You are RED. Reach ${WIN} nodes to win. —`);
  render();
}
function log(s){ logLines.unshift(s); if(logLines.length>200) logLines.pop(); }
function nodeAt(id){ return state.nodes[id]; }
function attackableFrom(id){
  const n = nodeAt(id);
  if(!n || n.owner!=='red' || n.strength<=1) return [];
  return state.adj[id].filter(nb=>state.nodes[nb].owner!=='red');
}

// animate one battle: show attacker->defender, pause, resolve, show outcome, pause.
async function animateBattle(from, to, faction){
  if(SPEED<=0){ const r=NW.resolveBattle(state,from,to); lastChanged=new Set([from,to]); return r; }
  hl = {from, to, result:null, faction};
  render(); await sleep(SPEED);
  const r = NW.resolveBattle(state, from, to);
  hl.result = r; lastChanged = new Set([from, to]);
  render(); await sleep(Math.max(140, SPEED*0.55));
  hl = null;
  return r;
}

async function clickNode(id){
  if(over || animating) return;
  const n = nodeAt(id);
  if(n.owner==='red'){
    sel = (n.strength>1 && sel!==id) ? id : null;
    render(); return;
  }
  if(sel!=null && attackableFrom(sel).includes(id)){
    animating=true; const from=sel;
    const r = await animateBattle(from, id, 'red');
    log(`YOU: node${from}(${r.fromStart}) → node${r.to}(${r.toStart}) — `
        + (r.captured?`captured (now ${r.toStrength})`:`repelled (def left ${r.toStrength})`));
    sel = nodeAt(from).strength>1 ? from : null;
    const w = NW.checkWinner(state); if(w) endGame(w);
    animating=false; render();
  }
}

async function endTurn(){
  if(over || animating) return;
  animating=true; sel=null; banner='You reinforce…';
  const rr = NW.reinforce(state, 'red');
  if(rr){ lastChanged=new Set(rr.border); log(`you reinforce: +${rr.amount} onto your largest blob's ${rr.border.length} border nodes`);
          render(); await sleep(Math.max(180, SPEED*0.7)); }
  for(const b of NW.BOTS){
    if(NW.counts(state)[b]===0) continue;
    let guard=0, caps=0, atks=0;
    while(guard++ < 1000){
      const mv = NW.bestBotMove(state, b);   // exactly runBotTurn's loop, one step at a time
      if(!mv) break;
      banner = `${b.toUpperCase()} attacks: node${mv.from}(${mv.atk}) → node${mv.to}(${mv.def})`;
      const r = await animateBattle(mv.from, mv.to, b);
      atks++; if(r.captured) caps++;
      log(`${b}: node${mv.from}(${r.fromStart}) → node${mv.to}(${r.toStart}) — `
          + (r.captured?`CAPTURED`:`repelled`));
      const w = NW.checkWinner(state); if(w){ endGame(w); break; }
    }
    if(over) break;
    const rb = NW.reinforce(state, b);
    if(rb){ banner=`${b.toUpperCase()} reinforces +${rb.amount}`; lastChanged=new Set(rb.border);
            log(`${b}: ${atks} attacks / ${caps} captures, then reinforce +${rb.amount}`);
            render(); await sleep(Math.max(160, SPEED*0.6)); }
  }
  banner=''; animating=false;
  if(!over){ const w=NW.checkWinner(state); if(w) endGame(w); }
  render();
}

function endGame(w){ over=w; banner=''; log(w==='red'?'🏆 YOU WIN!':`💀 ${w} wins — you lose.`); }
function setSpeed(v){ SPEED = parseInt(v); }

// --- import a board grabbed from the phone (grab_board.py) -------------------
function importNodes(arr){
  if(!Array.isArray(arr) || !arr.length){ alert('No nodes found in JSON.'); return; }
  // reindex to contiguous ids; build 8-connectivity (king) adjacency from (x,y),
  // exactly like the engine's lattice, so bots/reinforce/battle work unchanged.
  const nodes = arr.map((n,i)=>({ id:i, x:n.x, y:n.y, owner:n.owner,
                                  strength:(n.strength==null?1:n.strength) }));
  const adj = nodes.map(()=>[]); const links=[];
  for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
    if(Math.abs(nodes[i].x-nodes[j].x)<=1 && Math.abs(nodes[i].y-nodes[j].y)<=1){
      adj[i].push(j); adj[j].push(i); links.push([i,j]);
    }
  }
  state = {nodes, links, adj};
  state.rng = NW.makeRng((Math.floor(Math.random()*1e9))||1);   // fresh battle dice
  sel=null; over=null; logLines=[]; lastChanged=new Set(); hl=null; banner=''; animating=false;
  const c = NW.counts(state);
  log(`— imported phone board: ${nodes.length} nodes. You are RED (${c.red}). Counts ${JSON.stringify(c)}. —`);
  const w = NW.checkWinner(state); if(w) endGame(w);
  render();
}
function parseImport(text){
  let j; try{ j=JSON.parse(text); }catch(e){ alert('Bad JSON: '+e.message); return; }
  importNodes(Array.isArray(j) ? j : (j.nodes||[]));
}
function importFile(inp){
  const f = inp.files[0]; if(!f) return;
  const r = new FileReader(); r.onload = ()=>{ parseImport(r.result); inp.value=''; };
  r.readAsText(f);
}
function importPaste(){ const t=document.getElementById('pastebox').value.trim(); if(t) parseImport(t); }
async function syncPhone(){
  const btn=document.getElementById('syncbtn'); btn.disabled=true; const old=btn.textContent;
  btn.textContent='⏳ capturing…'; banner='syncing from phone…'; render();
  try{
    const r=await fetch('/grab',{cache:'no-store'});
    const j=await r.json();
    if(j.error){ alert('Sync failed: '+j.error); }
    else { importNodes(j.nodes); }
  }catch(e){
    alert('Sync needs the local server. Run:\n  python iphone_data/play_server.py\nthen open the http://127.0.0.1 URL it prints (not the file://).');
  }
  btn.disabled=false; btn.textContent=old; if(banner==='syncing from phone…'){banner='';} render();
}
function togglePaste(){
  const b=document.getElementById('pastebox'), r=document.getElementById('pasterow');
  const show = b.style.display==='none'; b.style.display = r.style.display = show?'block':'none';
}

function render(){
  const c = NW.counts(state);
  document.getElementById('counts').innerHTML = NW.FACTIONS.map(f=>
    `<span class="chip ${over===f?'champ':''}" style="background:${COLORS[f]}">${f==='red'?'you':f}: <b>${c[f]}</b></span>`
  ).join('') + `<span class="win">first to ${WIN} wins</span>`;
  document.getElementById('status').innerHTML =
    over ? `<b>${over==='red'?'You won! 🏆':`You lost — ${over} won.`}</b>`
         : animating ? (banner||'…')
         : (sel!=null ? `Selected node ${sel} (str ${nodeAt(sel).strength}) — click a ringed enemy to attack, or End Turn.`
                      : 'Your turn — click one of YOUR nodes (strength ≥ 2), then a bordering enemy.');
  const cell=78, pad=44, W=COLS*cell+pad, H=ROWS*cell+pad;
  const cx=id=>nodeAt(id).x*cell+pad/2+cell/2, cy=id=>nodeAt(id).y*cell+pad/2+cell/2;
  let svg=`<svg viewBox="0 0 ${W} ${H}" id="svg">`
        +`<defs><marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">`
        +`<path d="M0,0 L7,3 L0,6 Z" fill="#fff" /></marker></defs>`;
  for(const [a,b] of state.links)
    svg+=`<line x1=${cx(a)} y1=${cy(a)} x2=${cx(b)} y2=${cy(b)} stroke="#3a3a3c" stroke-width=3 />`;
  // battle arrow
  if(hl){
    const x1=cx(hl.from),y1=cy(hl.from),x2=cx(hl.to),y2=cy(hl.to);
    const ax=x1+(x2-x1)*0.72, ay=y1+(y2-y1)*0.72;
    svg+=`<line x1="${x1}" y1="${y1}" x2="${ax}" y2="${ay}" stroke="#fff" stroke-width="5" marker-end="url(#ah)" opacity="0.95" />`;
  }
  const att = (sel!=null && !animating) ? new Set(attackableFrom(sel)) : new Set();
  for(const n of state.nodes){
    const x=cx(n.id), y=cy(n.id);
    const isSel=n.id===sel, isAtt=att.has(n.id);
    const isAtkr = hl && hl.from===n.id, isDef = hl && hl.to===n.id;
    const clickable = (!over&&!animating) && ((n.owner==='red'&&n.strength>1) || isAtt);
    let ring='none', rw=0, dash='';
    if(isAtkr){ ring='#0affff'; rw=6; }
    else if(isDef){ ring=(hl.result&&hl.result.captured)?'#fff':'#ff3b30'; rw=6; }
    else if(isSel||isAtt){ ring='#fff'; rw=5; if(isAtt) dash='stroke-dasharray="4 3"'; }
    else if(lastChanged.has(n.id)){ ring='#ffd60a'; rw=4; }
    svg+=`<g class="${clickable?'clk':''}" onclick="clickNode(${n.id})">`
       +`<circle cx=${x} cy=${y} r=27 fill="${COLORS[n.owner]}" stroke="${ring}" stroke-width=${rw} ${dash} />`
       +`<text x=${x} y=${y+6} text-anchor="middle" class="st">${n.strength}</text></g>`;
  }
  svg+='</svg>';
  document.getElementById('board').innerHTML = svg;
  document.getElementById('log').innerHTML = logLines.map(l=>`<div>${l}</div>`).join('');
  document.getElementById('endbtn').disabled = !!over || animating;
}

window.clickNode=clickNode; window.endTurn=endTurn; window.newGame=newGame; window.setSpeed=setSpeed;
window.importFile=importFile; window.importPaste=importPaste; window.togglePaste=togglePaste; window.syncPhone=syncPhone;
if (window.__IMPORTED_BOARD__) importNodes(window.__IMPORTED_BOARD__.nodes || window.__IMPORTED_BOARD__);
else newGame(0);
"""

CSS = r"""
*{box-sizing:border-box} body{font-family:-apple-system,system-ui,sans-serif;background:#1c1c1e;color:#eee;margin:0;padding:18px}
h1{font-size:19px;margin:0 0 4px} .sub{color:#999;font-size:13px;margin-bottom:12px}
.wrap{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}
#board{flex:0 0 auto} svg{width:520px;height:auto;background:#161617;border-radius:14px}
.side{flex:1;min-width:260px;max-width:420px}
#counts{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center}
.chip{padding:4px 10px;border-radius:20px;font-size:13px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.win{color:#888;font-size:12px;margin-left:auto}
#status{min-height:34px;font-size:14px;background:#2c2c2e;border-radius:8px;padding:9px 12px;margin-bottom:10px}
.controls{display:flex;gap:10px;margin-bottom:12px;align-items:center}
button{background:#0a84ff;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer}
button:disabled{opacity:.4;cursor:default} button.ghost{background:#3a3a3c}
input{width:90px;background:#2c2c2e;border:1px solid #444;color:#eee;border-radius:7px;padding:8px}
.filebtn{background:#3a3a3c;color:#fff;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer}
.filebtn input{display:none}
.hint{color:#888;font-size:12px} .hint code{color:#aaa}
#pastebox{width:100%;height:70px;background:#161617;border:1px solid #444;color:#ccc;border-radius:8px;padding:8px;font-size:11px;font-family:ui-monospace,monospace;margin-bottom:8px}
#log{font-size:12.5px;line-height:1.55;max-height:430px;overflow:auto;background:#161617;border-radius:10px;padding:10px}
#log div{padding:1px 0;border-bottom:1px solid #242426}
.st{fill:#fff;font-weight:700;font-size:17px;text-shadow:0 1px 2px rgba(0,0,0,.6);pointer-events:none}
g.clk{cursor:pointer} g.clk:hover circle{filter:brightness(1.18)}
"""

def main():
    game = open(GAME_JS).read()
    # if a phone board was grabbed (grab_board.py), embed it so play_sim opens on it
    board_path = os.path.join(os.path.dirname(OUT), 'iphone_data', 'imported_board.json')
    board_js = ''
    if os.path.exists(board_path):
        board_js = f'<script>window.__IMPORTED_BOARD__ = {open(board_path).read()};</script>'
    html = f"""<!doctype html><html><head><meta charset="utf8">
<title>Network Wars — play the sim</title><style>{CSS}</style></head><body>
<h1>Network Wars — you (red) vs the sim bots</h1>
<div class="sub">Bit-identical to <code>game.js</code> (bestBotMove + reinforce + battle p=0.60).
Click your node (str ≥ 2), then a bordering enemy to attack. Reach 24 nodes to win.</div>
<div class="wrap">
  <div id="board"></div>
  <div class="side">
    <div id="counts"></div>
    <div class="controls">
      <button id="endbtn" onclick="endTurn()">End Turn ▶</button>
      <select onchange="setSpeed(this.value)" title="battle animation speed">
        <option value="700">Slow</option>
        <option value="420" selected>Normal</option>
        <option value="200">Fast</option>
        <option value="0">Instant</option>
      </select>
      <input id="seed" type="number" placeholder="seed" />
      <button class="ghost" onclick="newGame(parseInt(document.getElementById('seed').value)||0)">New Game</button>
    </div>
    <div class="controls">
      <button id="syncbtn" onclick="syncPhone()">🔄 Sync from phone</button>
      <label class="filebtn">Import board file<input id="boardfile" type="file" accept=".json,application/json" onchange="importFile(this)"></label>
      <button class="ghost" onclick="togglePaste()">paste JSON</button>
      <span class="hint">Sync needs <code>python iphone_data/play_server.py</code></span>
    </div>
    <textarea id="pastebox" placeholder="paste the board JSON printed by grab_board.py, then Load" style="display:none"></textarea>
    <div id="pasterow" style="display:none"><button class="ghost" onclick="importPaste()">Load pasted board</button></div>
    <div id="status"></div>
    <div id="log"></div>
  </div>
</div>
<script>var module={{exports:{{}}}};</script>
{board_js}
<script>
{game}
</script>
<script>
{UI}
</script>
</body></html>"""
    open(OUT, 'w').write(html)
    print(f'wrote {OUT}')


if __name__ == '__main__':
    main()
