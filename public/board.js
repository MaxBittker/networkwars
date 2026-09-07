// Board renderer + battle/bot-turn animation for index.html (the duplicate-format
// head-to-head match) — the one place the game's LOOK lives: octagon nodes,
// coin-flip replay, reinforce flashes. (Originally shared with a free-play page,
// removed 2026-08-14.)
//
// It renders only; it holds no rules and drives no engine. The page owns the game
// state (the authoritative view from engine.worker.js) and hands it here via
// setView(); the Board owns the canvas, the layout fit, and the transient
// decoration state that only exists during an animation (overrides / battle /
// flashId / reinforceFlash / animBoard).

// Sampled from the recording at 5s (idle), 10.8/20/26/36/54s (attacking).
// Idle fills are intentionally not a fixed multiple of the rim: green and purple
// are darker. Keep text normal-width; the reference's compressed type is not used.
export const NODE_PALETTE = {
  red:    { rim:'#ff4a62', body:'#a93343', bloom:'#f895a3', ink:'#be192b', attack:['#ffdbe2','#ffa9b6','#ff99a8','#ff4a62'] },
  green:  { rim:'#0ed887', body:'#006b43', bloom:'#69c5a2', ink:'#00a060', attack:['#d9f9f2','#a6efdf','#97edd9','#0ad5a8'] },
  yellow: { rim:'#e2b200', body:'#967600', bloom:'#e9ce69', ink:'#a88600', attack:['#fff7d8','#ffeeab','#ffeb98','#ffda3f'] },
  blue:   { rim:'#3b90f1', body:'#2a5fa0', bloom:'#8cbbef', ink:'#105ab5', attack:['#d6e9fd','#a1cbf8','#90c3f7','#3b90f1'] },
  purple: { rim:'#ac64f8', body:'#582988', bloom:'#af87d9', bloomY:.90, ink:'#702dba', attack:['#f0e0ff','#d9b6fb','#d1a9fb','#ac64f8'] },
};
const BATTLE_GLOW = { red:'#ff2842', green:'#00d785', yellow:'#ffd62a', blue:'#2084f5', purple:'#a143ff' };
export const COLORS = Object.fromEntries(Object.entries(NODE_PALETTE).map(([f, p]) => [f, p.rim]));
function tint(hex, white, alpha = 1) {
  const rgb = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
  return `rgba(${rgb.map(c => Math.round(c + (255-c)*white)).join(',')},${alpha})`;
}
export const ORDER = ['red','green','yellow','blue','purple'];
export const SPEEDS = { instant: 0, fast: 0.25, medium: 1, slow: 2 };  // sleep-time multiplier

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const cap = (s) => s[0].toUpperCase() + s.slice(1);

// one of 8 compass arrows for the on-board direction of an attack (screen y grows downward)
const DIR_ARROWS = ['→','↗','↑','↖','←','↙','↓','↘'];
export function dirArrow(f, t) {
  const a = Math.atan2(-(t.y - f.y), t.x - f.x);   // up is positive
  const idx = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return DIR_ARROWS[idx];
}

// Classic timings follow the reference's distinct focus / attrition / settle beats.
// Fast scales every beat; Instant skips the entire replay, including queued frames.
export const TIMING = Object.freeze({ focus: 240, casualty: 140, settle: 300,
  handoff: 220, reinforce: 520, gap: 100, arrow: 420 });

function octagon(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 4;
    const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

// Paint a tiny starting-board thumbnail (faction-colored dots laid out by x,y).
// Used by the per-seed scoreboard rows and the AI-progress badge.
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
    this.dragTo = null;             // {x,y} canvas pt: a drag-to-attack in progress from `selected`
    this.topInset = 0;             // px at the top the layout must keep clear
                                    // (e.g. the AI-progress badge overlays the canvas)

    // ---- transient state owned by the animations ----
    this.overrides = new Map();     // nodeId -> {strength, owner?} mid-battle
    this.battle = null;             // {from,to} of the active fight
    this.flashId = null;
    this.reinforceFlash = null;     // Set(nodeId)
    this.animBoard = null;          // mutable node copy used while animating bot turns
    this.light = 0;                 // battle/reinforcement brightness, 0..1
    this.pulse = 0;                 // casualty / reinforcement pulse, 0..1
    this.onReplay = () => {};       // page updates faction counters at event boundaries
    this.skins = new Map();         // shaded/glowing sprites; no blur work per frame
    this.size = { width: 0, height: 0 };
    this.positions = [];

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
    this.dragTo = null;
    this.indexMoves();
    this.positions = v.nodes.map(n => this.nodePos(n));
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
    this.size = { width: b.width, height: b.height };
    this.skins.clear();
    this.cv.width = b.width * dpr; this.cv.height = b.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.state) return;
    const maxX = Math.max(...this.state.nodes.map(n => n.x)) || 1;
    const maxY = Math.max(...this.state.nodes.map(n => n.y)) || 1;
    const pad = 38;
    // topInset shrinks the fit only when the centered board would reach under it;
    // with vertical slack the max() leaves the board dead-centered as before.
    // The inset protects the whole node (rim + halo), not just its center.
    const topPad = Math.max(pad, this.topInset + 30);
    const s = Math.min((b.width - pad*2) / maxX, (b.height - topPad - pad) / maxY);
    this.layout = { r: Math.min(s * 0.34, 26), s,
      ox: (b.width - maxX * s) / 2,
      oy: Math.max(topPad, (b.height - maxY * s) / 2) };
    this.positions = this.state.nodes.map(n => this.nodePos(n));
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

  // forgiving drag target: the nearest node in `ids` within `slop` node-radii of
  // the pointer (drags end sloppily; the exact hit test is too strict a release)
  nearestOf(mx, my, ids, slop = 2.2) {
    if (!this.state || !ids) return null;
    let best = null, bd = this.layout.r * slop;
    for (const id of ids) {
      const n = this.state.nodes[id]; if (!n) continue;
      const p = this.nodePos(n), d = Math.hypot(mx - p.x, my - p.y);
      if (d <= bd) { bd = d; best = n; }
    }
    return best;
  }

  // Paint the expensive bloom and shading once per size/faction/state. Animation
  // frames then composite sprites and numbers, without repeated canvas shadows.
  _skin(owner, mode = 'idle', glow = owner) {
    const key = `${owner}:${mode}:${glow}`;
    if (this.skins.has(key)) return this.skins.get(key);
    const r = this.layout.r, size = Math.ceil(r * 4.6);
    const cv = document.createElement('canvas'), dpr = window.devicePixelRatio || 1;
    cv.width = cv.height = Math.ceil(size * dpr);
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    const c = size / 2, palette = NODE_PALETTE[owner], idle = mode === 'idle';
    // Measured falloff outside the rim: idle glow is tight; a battle has a much
    // stronger saturated halo. A gradient also keeps its size consistent at any DPR.
    const glowColor = idle ? COLORS[glow] : BATTLE_GLOW[glow];
    const halo = ctx.createRadialGradient(c,c,0,c,c,r*1.75);
    const falloff = idle ? [[0,.5],[1,.4],[1.22,.19],[1.34,.08],[1.47,.016],[1.6,0],[1.75,0]]
      : [[0,1],[1,1],[1.22,.8],[1.34,.56],[1.47,.26],[1.7,0],[1.75,0]];
    for (const [radius, alpha] of falloff) halo.addColorStop(radius/1.75, tint(glowColor,0,alpha));
    ctx.fillStyle = halo; ctx.fillRect(0,0,size,size);
    if (mode === 'halo') {
      ctx.globalCompositeOperation = 'destination-out';
      octagon(ctx,c,c,r); ctx.fillStyle = '#000'; ctx.fill();
      const skin = { cv, size }; this.skins.set(key,skin); return skin;
    }
    octagon(ctx, c, c, r);
    if (idle) {
      ctx.fillStyle = palette.body;
    } else {
      const body = ctx.createLinearGradient(0, c-r, 0, c+r);
      if (mode === 'attacker') {
        body.addColorStop(0, tint(palette.rim, .94));
        for (const [i, stop] of [.2,.5,.65,1].entries())
          body.addColorStop(stop, palette.attack[i]);
      } else {
        // Defenders and reinforced nodes remain saturated, with pale light at
        // the top and bottom. This is distinct from the paler attacking stack.
        for (const [stop, white] of [[0,.86],[.2,.60],[.5,.24],[.65,.10],[.9,.44],[1,.22]])
          body.addColorStop(stop, tint(palette.rim, white));
      }
      ctx.fillStyle = body;
    }
    ctx.fill();
    if (idle) {
      // Localized soft light inside the lower face, not a whole-body gradient.
      ctx.save(); ctx.clip();
      ctx.translate(c, c + (palette.bloomY || .875)*r); ctx.scale(.85*r, .62*r);
      const bloom = ctx.createRadialGradient(0,0,0,0,0,1);
      bloom.addColorStop(0, palette.bloom);
      bloom.addColorStop(.2, palette.bloom);
      bloom.addColorStop(.55, tint(palette.bloom, 0, .45));
      bloom.addColorStop(1, tint(palette.bloom, 0, 0));
      ctx.fillStyle = bloom; ctx.fillRect(-1,-1,2,2);
      ctx.restore();
    }
    octagon(ctx, c, c, r * .95);
    ctx.lineJoin = 'round';
    ctx.lineWidth = idle ? Math.max(2, r * .13) : Math.max(.8, r * .045);
    ctx.strokeStyle = palette.rim; ctx.stroke();
    if (!idle) {
      // A fine white outside rim, with the owner's color retained inside it.
      octagon(ctx, c, c, r * .98);
      ctx.lineWidth = Math.max(.8, r * .045);
      ctx.strokeStyle = '#f5fff9'; ctx.stroke();
    }
    const skin = { cv, size }; this.skins.set(key, skin); return skin;
  }

  // Arrow travels from the source rim to the target rim, always on the link.
  // Static move previews use the default endpoint; battles supply their clock.
  _drawArrow(p1, p2, color, progress = 1) {
    const ctx = this.ctx, r = this.layout.r;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;          // unit p1->p2
    const px = -uy, py = ux;                      // perpendicular
    const gap = len - 2 * (r + 1);
    if (gap <= 0) return;
    const ah = Math.min(Math.max(5, r * .45), gap * .45);
    const aw = Math.min(Math.max(3, r * .25), ah * .7);
    const travel = r + 1 + ah + (gap - ah) * Math.max(0, Math.min(1, progress));
    const tipX = p1.x + ux * travel, tipY = p1.y + uy * travel;
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
    ctx.clearRect(0, 0, this.size.width, this.size.height);
    const nodes = this.animBoard || state.nodes;
    const pos = this.positions;
    if (pos.length !== nodes.length) return;
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
      else { ctx.strokeStyle = 'rgba(70,220,165,.65)'; ctx.lineWidth = 0.85; ctx.setLineDash([1.5,2.5]); ctx.shadowBlur = 0; }
      ctx.stroke();
      if (inBattle) { ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(234,255,246,.4)'; ctx.lineWidth = 1; ctx.stroke(); }
    }
    ctx.setLineDash([]); ctx.shadowBlur = 0;

    // nodes
    for (const n of nodes) {
      const p = pos[n.id];
      const ov = this.overrides.get(n.id);
      const owner = (ov && ov.owner) ? ov.owner : n.owner;
      const strength = ov ? ov.strength : n.strength;
      const isAtk = battle && n.id === battle.from;
      const isDef = battle && n.id === battle.to;
      const isSel = n.id === selected || isAtk;
      const isTarget = isDef || (selected !== null && targetsFor.get(selected)?.has(n.id));
      const isRein = this.reinforceFlash && this.reinforceFlash.has(n.id);
      // Both combatants brighten; only legal targets get a quiet extra outline.
      // Dark numerals on pale fighting nodes match the recording's contrast flip.
      const active = isAtk || isDef || isRein;
      const light = active ? this.light : (isSel ? .28 : 0);
      const pulse = isRein || n.id === this.flashId ? this.pulse : 0;
      const mode = isDef ? 'defender' : isRein ? 'reinforce' : 'attacker';
      const glow = (isAtk || isDef) ? nodes[battle.from].owner : owner;
      const skin = this._skin(owner), lit = this._skin(owner, mode, glow);
      const size = skin.size; // fixed geometry: only brightness changes during replay
      ctx.drawImage(skin.cv, p.x-size/2, p.y-size/2, size, size);
      if (light > 0) {
        ctx.globalAlpha = light;
        ctx.drawImage(lit.cv, p.x-size/2, p.y-size/2, size, size);
        ctx.globalAlpha = 1;
      }
      if (pulse > 0 && light > 0) {
        ctx.globalAlpha = .15 * pulse * light;
        ctx.drawImage(this._skin(owner, 'halo', glow).cv, p.x-size/2, p.y-size/2, size, size);
        ctx.globalAlpha = 1;
      }
      if (isTarget && !isDef) {
        octagon(ctx, p.x, p.y, layout.r * 1.12);
        ctx.strokeStyle = 'rgba(236,255,249,.8)'; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.save();
      ctx.translate(p.x, p.y + 1);
      ctx.fillStyle = light > .55 ? NODE_PALETTE[owner].ink : '#fff';
      ctx.font = `700 ${Math.round(layout.r * .88)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(strength, 0, 0);
      ctx.restore();
    }

    if (battle && pos[battle.from] && pos[battle.to])
      this._drawArrow(pos[battle.from], pos[battle.to], '#effff8',
        ((battle.elapsed || 0) % TIMING.arrow) / TIMING.arrow);

    // hovered suggestion: a directional arrow along the edge (drawn on top of nodes)
    if (hoverMove && hoverMove.from != null && hoverMove.to != null) {
      const pf = pos[hoverMove.from], pt = pos[hoverMove.to];
      if (pf && pt) this._drawArrow(pf, pt, '#ffd36b');
    }
    // drag-to-attack in progress: a free line from the selected node to the pointer
    // (once the pointer is over a legal target the page swaps this for hoverMove)
    if (this.dragTo && selected !== null && pos[selected]) {
      const pf = pos[selected], pt = this.dragTo;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(pf.x, pf.y); ctx.lineTo(pt.x, pt.y);
      ctx.strokeStyle = 'rgba(255,77,94,.75)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.shadowColor = COLORS.red; ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- animation ----

  // A single clock for all phases. Read speed every frame so changing to Instant
  // takes effect during a fight; use a timer fallback when a tab is backgrounded.
  async _beat(ms, frame = () => {}) {
    let elapsed = 0, last = performance.now();
    if (this.abort || this.instant) return;
    frame(0); this.draw();
    while (elapsed < ms && !this.abort && !this.instant) {
      await new Promise(resolve => {
        let raf;
        const finish = () => { clearTimeout(timer); cancelAnimationFrame(raf); resolve(); };
        const timer = setTimeout(finish, 50);
        raf = requestAnimationFrame(finish);
      });
      const now = performance.now();
      const delta = (now - last) / (this.speed || 1); last = now;
      elapsed += delta;
      if (this.battle) this.battle.elapsed = (this.battle.elapsed || 0) + delta;
      frame(Math.min(1, elapsed / ms)); this.draw();
    }
  }

  _clearAnimation() {
    this.overrides.clear(); this.battle = null; this.flashId = null;
    this.reinforceFlash = null; this.light = 0; this.pulse = 0;
  }

  // Human and bot attacks replay the SAME authoritative casualty log. No dice or
  // rules are simulated here. Commit both outcomes (including repels) before the
  // settle beat, and retain the local result until the page adopts its final view.
  async animateBattle(e) {
    const ownsBoard = !this.animBoard;
    if (ownsBoard) this.animBoard = this.state.nodes.map(n => ({ ...n }));
    const { from, to, fromStart, toStart, flips } = e;
    let a = fromStart, d = toStart;
    try {
      this.battle = { from, to, elapsed: 0 };
      this.overrides.set(from, { strength: a });
      this.overrides.set(to, { strength: d });
      await this._beat(TIMING.focus, t => { this.light = t; });
      for (const f of flips) {
        if (this.abort || this.instant) break;
        if (f === 'd') { d--; this.flashId = to; } else { a--; this.flashId = from; }
        this.overrides.set(from, { strength: a });
        this.overrides.set(to, { strength: Math.max(d, 0) });
        await this._beat(TIMING.casualty, t => { this.pulse = 1 - t; });
      }
      this.overrides.clear();
      this.animBoard[from].strength = e.fromStrength;
      this.animBoard[to].strength = e.toStrength;
      if (e.captured) this.animBoard[to].owner = e.attacker;
      this.flashId = e.captured ? to : from;
      this.onReplay(e.attacker, this.animBoard);
      await this._beat(TIMING.settle, t => { this.light = 1 - t; this.pulse = 1 - t; });
    } finally {
      this._clearAnimation();
      if (ownsBoard) this.animBoard = null;
    }
  }

  // The working board and header advance together, only at event boundaries.
  async animateEndTurn(res, onStatus = () => {}) {
    this.animBoard = this.state.nodes.map(n => ({ ...n }));
    this.selected = null; this.hoverMove = null; this.dragTo = null;
    let curFaction = null;
    try {
      for (const ev of res.events) {
        if (this.abort || this.instant) break;
        const faction = ev.type === 'reinforce' ? ev.faction : ev.attacker;
        if (faction !== curFaction) {
          curFaction = faction;
          this.onReplay(faction, this.animBoard);
          onStatus(faction === 'red' ? 'Your reinforcements.' : `${cap(faction)}’s turn…`);
          await this._beat(TIMING.handoff);
        }
        if (ev.type === 'reinforce') {
          onStatus(faction === 'red' ? 'Your reinforcements.' : `${cap(faction)} reinforces.`);
          this.reinforceFlash = new Set(ev.changes.map(c => c.id));
          await this._beat(TIMING.focus, t => { this.light = t; });
          for (const ch of ev.changes) this.animBoard[ch.id].strength = ch.to;
          await this._beat(TIMING.reinforce, t => {
            this.light = 1 - t; this.pulse = Math.sin(Math.PI * t);
          });
          this._clearAnimation();
        } else {
          onStatus(`${cap(faction)} attacks…`);
          await this.animateBattle(ev);
        }
        await this._beat(TIMING.gap);
      }
    } finally {
      this._clearAnimation(); this.animBoard = null;
    }
  }
}
