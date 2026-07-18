// Shared board renderer + battle/bot-turn animation, used by BOTH index.html (free
// play) and head-to-head.html (the duplicate-format match). Extracted so the two
// pages can't drift apart on how the game LOOKS — same octagon nodes, same
// coin-flip replay, same reinforce flashes.
//
// It renders only; it holds no rules and drives no engine. The page owns the game
// state (the authoritative view from engine.worker.js) and hands it here via
// setView(); the Board owns the canvas, the layout fit, and the transient
// decoration state that only exists during an animation (overrides / battle /
// flashId / reinforceFlash / animBoard).

export const COLORS = { red:'#ff4d5e', green:'#36d39a', yellow:'#f5c542', blue:'#4d8bff', purple:'#a96bff' };
export const ORDER = ['red','green','yellow','blue','purple'];
export const SPEEDS = { instant: 0, fast: 0.5, medium: 1, slow: 2 };  // sleep-time multiplier

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const cap = (s) => s[0].toUpperCase() + s.slice(1);

// one of 8 compass arrows for the on-board direction of an attack (screen y grows downward)
const DIR_ARROWS = ['→','↗','↑','↖','←','↙','↓','↘'];
export function dirArrow(f, t) {
  const a = Math.atan2(-(t.y - f.y), t.x - f.x);   // up is positive
  const idx = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return DIR_ARROWS[idx];
}

// Per-faction node styles, cached by hex. Sampled from iOS screenshots: the rim
// is a slightly whitened faction color, and the body is a MEDIUM tone of it
// (~0.65x the rim) — not near-black like our old fill.
const _style = {};
function nodeStyle(hex) {
  if (_style[hex]) return _style[hex];
  const s = hex.replace('#', '');
  const r = parseInt(s.slice(0,2),16), g = parseInt(s.slice(2,4),16), b = parseInt(s.slice(4,6),16);
  const lift = (c) => Math.round(c + (255 - c) * 0.12);
  return (_style[hex] = {
    ring: `rgb(${lift(r)},${lift(g)},${lift(b)})`,
    body: `rgb(${Math.round(r*0.58+22)},${Math.round(g*0.58+22)},${Math.round(b*0.58+22)})`,
  });
}

// Paint a tiny starting-board thumbnail (faction-colored dots laid out by x,y).
// Used by index.html's game history and head-to-head's per-seed scoreboard rows.
export function drawThumb(cv, nodes) {
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, pad = 5;
  ctx.clearRect(0, 0, W, H);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
  const sx = (W - 2*pad) / Math.max(1, maxX - minX), sy = (H - 2*pad) / Math.max(1, maxY - minY);
  const s = Math.min(sx, sy), r = Math.max(1.4, s * 0.32);
  for (const n of nodes) {
    const x = pad + (n.x - minX) * s, y = pad + (n.y - minY) * s;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
    ctx.fillStyle = COLORS[n.owner] || '#888'; ctx.fill();
  }
}

export class Board {
  // canvas: the <canvas> to paint; boardEl: its sizing parent (measured on resize)
  constructor(canvas, boardEl) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.boardEl = boardEl;
    this.state = null;              // authoritative view from the worker
    this.layout = { r: 20, s: 1, ox: 0, oy: 0 };

    // ---- decorations the PAGE sets ----
    this.selected = null;           // selected red node id
    this.targetsFor = new Map();    // from -> Set(to), indexed from view.legalMoves
    this.hoverMove = null;          // {from,to} previewed on the grid
    this.topInset = 0;              // px at the top the layout must keep clear
                                    // (e.g. head-to-head's AI badge overlays the canvas)

    // ---- transient state owned by the animations ----
    this.overrides = new Map();     // nodeId -> {strength, owner?} mid-battle
    this.battle = null;             // {from,to} of the active fight
    this.flashId = null;
    this.reinforceFlash = null;     // Set(nodeId)
    this.animBoard = null;          // mutable node copy used while animating bot turns

    this.speed = 1;                 // sleep multiplier (0 = instant, no replay)
    this.abort = false;             // set by the page to fast-forward a replay
  }

  get instant() { return this.speed === 0; }

  // Adopt a fresh authoritative view. Re-indexes legal moves and drops the
  // selection — every board change starts the next choice fresh.
  setView(v) {
    this.state = v;
    this.selected = null;
    this.hoverMove = null;
    this.indexMoves();
  }

  indexMoves() {
    this.targetsFor = new Map();
    for (const m of (this.state?.legalMoves || [])) {
      if (!this.targetsFor.has(m.from)) this.targetsFor.set(m.from, new Set());
      this.targetsFor.get(m.from).add(m.to);
    }
  }

  // ---- layout ----
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const b = this.boardEl.getBoundingClientRect();
    this.cv.width = b.width * dpr; this.cv.height = b.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.state) return;
    const maxX = Math.max(...this.state.nodes.map(n => n.x)) || 1;
    const maxY = Math.max(...this.state.nodes.map(n => n.y)) || 1;
    const pad = 38;
    // topInset shrinks the fit only when the centered board would reach under it;
    // with vertical slack the max() leaves the board dead-centered as before.
    const topPad = Math.max(pad, this.topInset);
    const s = Math.min((b.width - pad*2) / maxX, (b.height - topPad - pad) / maxY);
    this.layout = { r: Math.min(s * 0.34, 26), s,
      ox: (b.width - maxX * s) / 2,
      oy: Math.max(topPad, (b.height - maxY * s) / 2) };
    this.draw();
  }

  nodePos(n) { return { x: this.layout.ox + n.x * this.layout.s, y: this.layout.oy + n.y * this.layout.s }; }

  hitNode(mx, my) {
    if (!this.state) return null;
    for (const n of this.state.nodes) {
      const p = this.nodePos(n);
      if (Math.hypot(mx - p.x, my - p.y) <= this.layout.r) return n;
    }
    return null;
  }

  // vertex-up octagon — matches the real game's node shape (verified by fitting
  // n-gon outlines to iOS screenshots: n=8, vertex at 12 o'clock)
  _octagon(x, y, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI/2 + Math.PI/8 + Math.PI/8 + i * Math.PI/4;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  // directional arrowhead near p2, pointing from p1 -> p2 (tip just outside p2's ring)
  _drawArrow(p1, p2, color) {
    const ctx = this.ctx, r = this.layout.r;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;          // unit p1->p2
    const px = -uy, py = ux;                      // perpendicular
    const tipX = p2.x - ux * (r + 1), tipY = p2.y - uy * (r + 1);
    const ah = Math.max(5, r * 0.45);            // arrowhead length (small, sits at the target end)
    const aw = Math.max(3.5, r * 0.3);           // arrowhead half-width
    const bx = tipX - ux * ah, by = tipY - uy * ah;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(bx + px * aw, by + py * aw);
    ctx.lineTo(bx - px * aw, by - py * aw);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  draw() {
    const state = this.state;
    if (!state) return;
    const ctx = this.ctx, layout = this.layout;
    const b = this.boardEl.getBoundingClientRect();
    ctx.clearRect(0, 0, b.width, b.height);
    const nodes = this.animBoard || state.nodes;
    const pos = nodes.map(n => this.nodePos(n));
    const { battle, selected, hoverMove, targetsFor } = this;

    // links
    for (const [a, c] of state.links) {
      const inBattle = battle && ((a===battle.from && c===battle.to) || (a===battle.to && c===battle.from));
      const selHot = selected !== null && (
           (a===selected && targetsFor.get(selected)?.has(c))
        || (c===selected && targetsFor.get(selected)?.has(a)));
      const isHover = hoverMove && ((a===hoverMove.from && c===hoverMove.to) || (a===hoverMove.to && c===hoverMove.from));
      ctx.beginPath();
      ctx.moveTo(pos[a].x, pos[a].y); ctx.lineTo(pos[c].x, pos[c].y);
      // an active fight draws a bright line in the ATTACKER's color (from-node owner)
      if (inBattle) { const ac = COLORS[nodes[battle.from].owner] || COLORS.red;
        ctx.strokeStyle = ac; ctx.lineWidth = 4; ctx.setLineDash([]); ctx.shadowColor = ac; ctx.shadowBlur = 12; }
      else if (selHot) { ctx.strokeStyle = COLORS.red; ctx.lineWidth = 4; ctx.setLineDash([]); ctx.shadowColor = COLORS.red; ctx.shadowBlur = 10; }
      else if (isHover) { ctx.strokeStyle = 'rgba(255,211,107,.9)'; ctx.lineWidth = 3.5; ctx.setLineDash([]); ctx.shadowColor = '#ffd36b'; ctx.shadowBlur = 12; }
      else { ctx.strokeStyle = 'rgba(110,220,170,.38)'; ctx.lineWidth = 1.5; ctx.setLineDash([3,5]); ctx.shadowBlur = 0; }
      ctx.stroke();
    }
    ctx.setLineDash([]); ctx.shadowBlur = 0;

    // nodes
    for (const n of nodes) {
      const p = pos[n.id];
      const ov = this.overrides.get(n.id);
      const owner = (ov && ov.owner) ? ov.owner : n.owner;
      const strength = ov ? ov.strength : n.strength;
      const col = COLORS[owner];
      const isAtk = battle && n.id === battle.from;
      const isDef = battle && n.id === battle.to;
      const isSel = n.id === selected || isAtk;
      const isTarget = isDef || (selected !== null && targetsFor.get(selected)?.has(n.id));
      const isFlash = n.id === this.flashId;
      const isRein = this.reinforceFlash && this.reinforceFlash.has(n.id);
      // Real-game look (sampled from iOS screenshots): flat medium-tone colored
      // body, a thick rounded rim in the faction color, and a strong soft halo
      // around the whole node.
      const st = nodeStyle(col);
      const r = layout.r;
      const hot = isFlash || isRein || isSel;
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = isFlash ? r*1.4 : (isRein ? r*1.3 : (isSel ? r*1.1 : (isTarget ? r*0.85 : r*0.6)));
      this._octagon(p.x, p.y, r);
      ctx.fillStyle = st.body;
      ctx.fill();
      ctx.fill();                       // second pass deepens the halo like the game's bloom
      ctx.restore();
      // rim: thick (~0.13r in the real game), rounded corners, glowing
      ctx.save();
      this._octagon(p.x, p.y, r * 0.93);
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2.5, r * (hot || isTarget ? 0.17 : 0.14));
      ctx.strokeStyle = (isFlash || isRein) ? '#fff' : st.ring;
      ctx.shadowColor = col;
      ctx.shadowBlur = hot ? r*0.7 : r*0.4;
      ctx.stroke();
      ctx.restore();
      // number (white, with a soft dark shadow so it reads over the colored body)
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.font = `800 ${Math.round(layout.r*0.85)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 3;
      ctx.fillText(strength, p.x, p.y + 1);
      ctx.restore();
    }

    // hovered suggestion: a directional arrow along the edge (drawn on top of nodes)
    if (hoverMove && hoverMove.from != null && hoverMove.to != null) {
      const pf = pos[hoverMove.from], pt = pos[hoverMove.to];
      if (pf && pt) this._drawArrow(pf, pt, '#ffd36b');
    }
  }

  // ---- animation ----

  // Replay the engine's coin-flip sequence before showing the result. The page's
  // state stays PRE-attack throughout, so an abort mid-replay leaves nothing stale.
  async animateBattle(e) {
    const { from, to, fromStart, toStart, flips } = e;
    let a = fromStart, d = toStart;
    this.flashId = null;
    this.battle = { from, to };
    this.overrides.set(from, { strength: a });
    this.overrides.set(to, { strength: d });
    this.draw();
    await sleep(180 * this.speed);
    const delay = Math.max(45, Math.min(150, Math.round(850 / Math.max(flips.length, 1)))) * this.speed;
    for (const f of flips) {
      if (this.abort) break;                    // undo requested — fast-forward
      if (f === 'd') { d--; this.flashId = to; } else { a--; this.flashId = from; }
      this.overrides.set(from, { strength: a });
      this.overrides.set(to, { strength: Math.max(d, 0) });
      this.draw();
      await sleep(delay);
    }
    this.flashId = null;
    if (e.captured) {
      this.overrides.set(to, { strength: e.toStrength, owner: e.attacker });
      this.overrides.set(from, { strength: e.fromStrength });
      this.draw();
      if (!this.abort) await sleep(240 * this.speed);
    }
    this.overrides.clear();
    this.battle = null;
  }

  // One bot battle, compact: highlight from->to in the attacker's color, then commit
  // the result with a flash. (Flip-by-flip is reserved for the player's own attacks.)
  async _animateBotBattle(e) {
    const from = this.animBoard[e.from], to = this.animBoard[e.to];
    this.battle = { from: e.from, to: e.to };
    this.overrides.set(e.from, { strength: e.fromStart });
    this.overrides.set(e.to, { strength: e.toStart });
    this.draw();
    if (!this.abort) await sleep(170 * this.speed);
    // commit to the working board
    from.strength = e.fromStrength;
    if (e.captured) { to.owner = e.attacker; to.strength = e.toStrength; }
    else { to.strength = e.toStrength; }
    this.flashId = e.captured ? e.to : e.from;
    this.overrides.clear();
    this.draw();
    if (!this.abort) await sleep(150 * this.speed);
    this.flashId = null;
    this.battle = null;
  }

  // Replay RED reinforce + the four bot turns, step by step, from the engine's event
  // log. Works on a local copy so each move is visible; the page adopts the
  // authoritative final state afterwards. onStatus(text) narrates whose turn it is.
  async animateEndTurn(res, onStatus = () => {}) {
    this.animBoard = this.state.nodes.map(n => ({ ...n }));
    this.selected = null;
    let curFaction = null;
    for (const ev of res.events) {
      if (this.abort) break;                 // undo requested — skip the rest of the replay
      if (ev.type === 'reinforce') {
        for (const ch of ev.changes) this.animBoard[ch.id].strength = ch.to;
        this.reinforceFlash = new Set(ev.changes.map(c => c.id));
        if (ev.faction !== 'red') onStatus(`${cap(ev.faction)} reinforces.`);
        this.draw();
        await sleep((ev.faction === 'red' ? 160 : 240) * this.speed);
        this.reinforceFlash = null;
        this.draw();
      } else {
        if (ev.attacker !== curFaction) {
          curFaction = ev.attacker;
          onStatus(`${cap(ev.attacker)} is attacking…`);
        }
        await this._animateBotBattle(ev);
      }
    }
    this.animBoard = null;
    this.reinforceFlash = null;
  }
}
