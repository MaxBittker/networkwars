#!/usr/bin/env python3
"""Visual digit-audit from LOST real games. For every node screenshot that can be
content-matched to a logged board of a game that was LOST, group the node crops by
the strength the parser reads (using the CURRENT parse.py reader) and lay them out
as a 10x10 grid per value. A human scans each grid for cells that don't match the
label (e.g. a "4" sitting in the "6" grid) -> a residual OCR mistake.

Screenshot<->game linkage is by CONTENT (owners must match the logged board >=28/30),
because g* filenames are overwritten across runs. Output: digit_grids.html.

Usage: python digit_grids.py [--per 100] [--out digit_grids.html]
"""
import argparse, base64, glob, io, json, os, random
import numpy as np
from PIL import Image
import parse as P

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ['runs/series_20260622_prsearch.jsonl', 'runs/series_20260621_battle.jsonl',
         'runs/series_16k.jsonl', 'runs/series_20260621_200g.jsonl']


def candidate_boards():
    """filename -> list of (logged_board, result). One filename may have candidates
    from several runs/games; we disambiguate by content at parse time."""
    cand = {}
    for f in FILES:
        if not os.path.exists(f):
            continue
        for line in open(f):
            try: r = json.loads(line)
            except: continue
            if r.get('type') != 'game':
                continue
            gi, res = r.get('game_index'), r.get('result')
            if gi is None:
                continue
            for t in r.get('trajectory', []):
                rnd = t.get('round')
                if rnd == 0 and t.get('board_before'):
                    cand.setdefault(f'g{gi}_r0.png', []).append((t['board_before'], res))
                for a, m in enumerate(t.get('moves', [])):
                    if m.get('result') == 'applied' and m.get('board_after'):
                        cand.setdefault(f'g{gi}_r{rnd}_a{a}.png', []).append((m['board_after'], res))
    return cand


def owners_of(board):
    return [n['o'] for n in sorted(board, key=lambda n: (n['r'], n['c']))]


def match_result(parsed_nodes, candidates):
    """Return the result of the candidate logged board whose owners best match the
    parsed screenshot (>=28/30), else None."""
    pj = [(n['row'], n['col'], n['owner']) for n in sorted(parsed_nodes, key=lambda n: (n['row'], n['col']))]
    if len(pj) != 30:
        return None
    powners = [o for _, _, o in pj]
    best, bestres = 0, None
    for board, res in candidates:
        if len(board) != 30:
            continue
        ow = owners_of(board)
        match = sum(1 for a, b in zip(powners, ow) if a == b)
        if match > best:
            best, bestres = match, res
    return bestres if best >= 28 else None


def crop(im, cx, cy, box=64, out=58):
    H, W, _ = im.shape
    x0, y0 = max(0, int(cx) - box // 2), max(0, int(cy) - box // 2)
    sub = im[y0:y0 + box, x0:x0 + box]
    return np.asarray(Image.fromarray(sub).resize((out, out), Image.BILINEAR))


def montage_b64(crops, cols=10, cell=58, pad=2):
    n = len(crops)
    rows = (n + cols - 1) // cols
    W = cols * cell + (cols + 1) * pad
    H = rows * cell + (rows + 1) * pad
    canvas = np.full((H, W, 3), 30, np.uint8)
    for i, c in enumerate(crops):
        r, cc = divmod(i, cols)
        y = pad + r * (cell + pad); x = pad + cc * (cell + pad)
        canvas[y:y + cell, x:x + cell] = c
    buf = io.BytesIO(); Image.fromarray(canvas).save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--per', type=int, default=100)
    ap.add_argument('--out', default='digit_grids.html')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--results', default='loss', choices=['loss', 'all'],
                    help="which game results to source screenshots from")
    ap.add_argument('--min-val', type=int, default=0, help="only build grids for values >= this")
    ap.add_argument('--max-val', type=int, default=10 ** 9)
    a = ap.parse_args()
    want = (lambda res: True) if a.results == 'all' else (lambda res: res == 'loss')

    cand = candidate_boards()
    todo = [fn for fn, cs in cand.items()
            if any(want(res) for _, res in cs) and os.path.exists(os.path.join('captures', fn))]
    print(f"{len(cand)} candidate filenames; {len(todo)} on-disk matching results={a.results}", flush=True)

    by_val = {}   # value -> list of (file, px, py)
    confirmed = 0
    for i, fn in enumerate(todo):
        path = os.path.join('captures', fn)
        try:
            st = P.parse(path)
        except Exception:
            continue
        if len(st['nodes']) < 25:
            continue
        res = match_result(st['nodes'], cand[fn])
        if res is None or not want(res):
            continue
        confirmed += 1
        for n in st['nodes']:
            v = n['strength']
            if v is None or v < a.min_val or v > a.max_val:
                continue
            by_val.setdefault(v, []).append((path, n['px'], n['py']))
        if (i + 1) % 500 == 0:
            print(f"  {i+1}/{len(todo)} scanned, {confirmed} confirmed loss-boards", flush=True)

    print(f"confirmed loss-game boards: {confirmed}; distinct values: {sorted(by_val)}", flush=True)

    rng = random.Random(a.seed)
    sections = []
    for v in sorted(by_val):
        items = by_val[v]
        n_total = len(items)
        if n_total > a.per:
            items = rng.sample(items, a.per)
        crops = []
        cache = {}
        for path, px, py in items:
            im = cache.get(path)
            if im is None:
                im = np.asarray(Image.open(path).convert('RGB')); cache[path] = im
            crops.append(crop(im, px, py))
        b64 = montage_b64(crops)
        sections.append(f"<h2>strength {v} &nbsp;<span class=cnt>(n={n_total}"
                        f"{', showing '+str(len(items)) if n_total>len(items) else ''})</span></h2>"
                        f"<img src='data:image/png;base64,{b64}'>")

    html = f"""<!doctype html><meta charset=utf-8><title>digit grids — lost games</title>
<style>
 body{{background:#111;color:#ddd;font:13px -apple-system,sans-serif;margin:16px}}
 h1{{font-size:19px}} h2{{font-size:15px;color:#9cf;margin:22px 0 6px}}
 .cnt{{color:#789;font-weight:normal;font-size:12px}}
 img{{image-rendering:pixelated;border:1px solid #333;border-radius:6px}}
 .hdr{{color:#bbb;max-width:880px;margin-bottom:8px}}
</style>
<h1>Digit audit — lost real games only ({confirmed} confirmed boards)</h1>
<div class=hdr>Each grid holds up to {a.per} node crops the parser read as that strength
(using the FIXED reader). Scan each grid for any cell whose number doesn't match the
heading — that's a residual OCR mistake.</div>
{''.join(sections)}
"""
    out = os.path.join(HERE, a.out)
    open(out, 'w').write(html)
    print(f"\nwrote {out}  ({len(by_val)} value grids)")


if __name__ == '__main__':
    main()
