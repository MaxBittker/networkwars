#!/usr/bin/env python3
"""Build double_digit_ocr.html: every DISTINCT double-digit node-strength OCR read
in captures/, cropped from its source screenshot and labelled with the claimed
value, so a human can eyeball which reads are wrong.

Distinct = unique (game, round, node_id, strength); collapses retry/duplicate
frames within a round. Crops a 90x96 box centred on the node's (px,py), upscaled
2x. Sorted by value DESCENDING so the implausible big reads (>26, almost
certainly errors) come first. Run from solver/iphone_data/."""
import json, glob, os, re
from collections import defaultdict
from PIL import Image

CAP = 'captures'
OUT_DIR = 'dd_crops'
HTML = 'double_digit_ocr.html'
BOX_W, BOX_H, ZOOM = 90, 96, 2
MIN_VAL = 10
PLAUSIBLE_MAX = 26   # > this is almost certainly an OCR error (deck tops out ~26)

os.makedirs(OUT_DIR, exist_ok=True)
# ONLY clean action frames "g{G}_r{R}_a{A}". The "_end" frames are captured at
# round end and can land on a round-end / "You Lost! Play again?" game-over MODAL;
# "bc_" are before-capture probes. We additionally drop any action frame that
# caught a transient OVERLAY/transition: when a popup occludes the board the
# parser force-parses a garbage 30-node board (hallucinated owners/strengths) —
# detectable as an IMPOSSIBLE faction-count swing between consecutive actions of
# the same round (a red turn captures <=1 node/action, so counts barely move).
SWING = 4  # max plausible per-faction count change between consecutive actions
pat = re.compile(r'^g(\d+)_r(\d+)_a(\d+)')

# pass 1: load action frames, group by game, ordered by (round, action)
frames = {}  # basename -> (game, round, action, counts, nodes, png)
games = defaultdict(list)
for jf in glob.glob(os.path.join(CAP, '*.json')):
    b = os.path.basename(jf)
    m = pat.match(b)
    if not m:
        continue
    g, rd, a = int(m.group(1)), int(m.group(2)), int(m.group(3))
    png = jf[:-5] + '.png'
    if not os.path.exists(png):
        continue
    try:
        d = json.load(open(jf))
    except Exception:
        continue
    if not isinstance(d.get('nodes'), list):
        continue
    frames[b] = (g, rd, a, d.get('counts', {}), d['nodes'], png)
    games[g].append(b)

# pass 2: flag overlay/transition-corrupt frames via intra-round count swings
corrupt = set()
for g, bs in games.items():
    bs.sort(key=lambda b: (frames[b][1], frames[b][2]))
    for prev, cur in zip(bs, bs[1:]):
        pr, cu = frames[prev], frames[cur]
        if pr[1] != cu[1]:           # different round — bots moved, skip
            continue
        pc, cc = pr[3], cu[3]
        if max(abs(cc.get(k, 0) - pc.get(k, 0)) for k in set(pc) | set(cc)) > SWING:
            corrupt.add(prev); corrupt.add(cur)

# pass 3: collect distinct double-digit events from CLEAN frames only
events = {}
for b, (g, rd, a, counts, nodes, png) in frames.items():
    if b in corrupt:
        continue
    for nd in nodes:
        s = nd.get('strength')
        if isinstance(s, int) and s >= MIN_VAL and nd.get('px') is not None:
            key = (g, rd, nd.get('id'), s)
            events.setdefault(key, (png, nd['px'], nd['py'], nd.get('owner')))
print(f'flagged {len(corrupt)} overlay/transition-corrupt frames '
      f'(of {len(frames)} action frames)')

# sort: value desc, then game, round, node
items = sorted(events.items(), key=lambda kv: (-kv[0][3], kv[0][0], kv[0][1], kv[0][2]))
print(f'{len(items)} distinct double-digit events '
      f'({sum(1 for k,_ in items if k[3] > PLAUSIBLE_MAX)} implausible >{PLAUSIBLE_MAX})')

# crop (cache the most-recently opened image since a frame yields several nodes)
_cache = {'png': None, 'im': None}
def crop(png, px, py):
    if _cache['png'] != png:
        _cache['png'] = png
        _cache['im'] = Image.open(png).convert('RGB')
    im = _cache['im']
    x0, y0 = int(px - BOX_W / 2), int(py - BOX_H / 2)
    c = im.crop((max(0, x0), max(0, y0), min(im.width, x0 + BOX_W),
                 min(im.height, y0 + BOX_H)))
    return c.resize((c.width * ZOOM, c.height * ZOOM), Image.NEAREST)

by_val = defaultdict(list)
for (g, rd, nid, val), (png, px, py, owner) in items:
    fn = f'dd_{val:03d}_g{g}_r{rd}_n{nid}.png'
    crop(png, px, py).save(os.path.join(OUT_DIR, fn))
    by_val[val].append((fn, g, rd, nid, owner))

# HTML
cells = []
for val in sorted(by_val, reverse=True):
    bad = val > PLAUSIBLE_MAX
    cells.append(
        f'<h2 class="{"bad" if bad else "ok"}">claimed = {val} '
        f'<span class="cnt">({len(by_val[val])} read{"s" if len(by_val[val])!=1 else ""}'
        f'{" — implausible, deck tops ~26" if bad else ""})</span></h2>')
    cells.append('<div class="grid">')
    for fn, g, rd, nid, owner in by_val[val]:
        cells.append(
            f'<figure><img loading="lazy" src="{OUT_DIR}/{fn}">'
            f'<figcaption><b>{val}</b> · g{g} r{rd} #{nid}<br>{owner}</figcaption></figure>')
    cells.append('</div>')

n_total = len(items)
n_bad = sum(1 for k, _ in items if k[3] > PLAUSIBLE_MAX)
html = f"""<!doctype html><meta charset=utf-8>
<title>Double-digit OCR audit — {n_total} reads</title>
<style>
 body{{font:14px/1.4 -apple-system,sans-serif;margin:24px;background:#111;color:#eee}}
 h1{{font-size:20px}} .sub{{color:#aaa;margin-bottom:20px}}
 h2{{margin:28px 0 8px;font-size:16px;border-bottom:1px solid #333;padding-bottom:4px}}
 h2.bad{{color:#ff6b6b}} h2.ok{{color:#9ad}} .cnt{{color:#888;font-weight:normal;font-size:13px}}
 .grid{{display:flex;flex-wrap:wrap;gap:10px}}
 figure{{margin:0;text-align:center}}
 img{{display:block;border:1px solid #333;border-radius:6px;image-rendering:pixelated}}
 figcaption{{font-size:11px;color:#bbb;margin-top:3px}}
 figcaption b{{color:#fff}}
</style>
<h1>Double-digit OCR audit</h1>
<div class=sub>{n_total} distinct double-digit reads (unique game·round·node·value)
from clean action frames only (g*_r*_a*; round-end / game-over modal frames
excluded). <b>{n_bad}</b> are &gt;{PLAUSIBLE_MAX} (almost certainly errors).
Each crop is the node as the OCR saw it; the bold number is what we read. Sorted
by value, biggest first. Tell me which are wrong.</div>
{''.join(cells)}
"""
open(HTML, 'w').write(html)
print(f'wrote {HTML} ({len(by_val)} value groups, crops in {OUT_DIR}/)')
