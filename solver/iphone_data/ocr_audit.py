#!/usr/bin/env python3
"""OCR audit: find historical board screenshots whose digit reads are LOW-CONFIDENCE
(ambiguous between two templates, or a poor match to any) and present them in an HTML
gallery — a crop of each suspect node + what the parser read + the runner-up — so a
human can eyeball whether the OCR was wrong.

Signal: parse.read_strength_tm reads each digit by nearest-template pixel SSD (scoped
by enclosed-hole count). For each glyph we record best SSD, the runner-up digit/SSD
(globally, across all 10 templates), and value heuristics. A small best-vs-runner-up
margin = the parser nearly read a different number = prime mis-OCR suspect.

Usage:
  python ocr_audit.py [--sample 1500] [--top 250] [--glob 'captures/g*.png']
                      [--out ocr_audit.html]
"""
import argparse, base64, glob, io, math, os, random, sys
import numpy as np
from PIL import Image
import parse as P

HERE = os.path.dirname(os.path.abspath(__file__))


def digit_details(im, cx, cy):
    """Replicate read_strength_tm but return per-glyph confidence details.
    Returns (value:int|None, glyph_infos:list). Each info:
      {read, read_ssd, alt, alt_ssd, margin}  (alt = best DIFFERENT digit globally)."""
    bank = P._bank()
    if not bank:
        return None, []
    m = P._clean_mask(im, cx, cy)
    if m is None:
        return None, []
    glyphs = P._segment_glyphs(m)
    if not glyphs:
        return None, []
    vals = sorted(bank)
    digits, infos = [], []
    for g in glyphs:
        h = P._holes(g)
        cands = [v for v in vals if P._BANK_HOLES.get(v) == h] or vals
        # scoped pick (what the reader actually returns)
        read = min(cands, key=lambda v: float(((g - bank[v]) ** 2).sum()))
        # global ranking over ALL digits (catches hole-class misassignment too)
        gssd = sorted(((float(((g - bank[v]) ** 2).sum())), v) for v in vals)
        read_ssd = next(s for s, v in gssd if v == read)
        alt, alt_ssd = next(((v, s) for s, v in gssd if v != read), (None, math.inf))
        digits.append(read)
        infos.append({'read': read, 'read_ssd': read_ssd, 'alt': alt,
                      'alt_ssd': alt_ssd, 'margin': alt_ssd - read_ssd})
    try:
        value = int(''.join(str(d) for d in digits))
    except ValueError:
        value = None
    return value, infos


def suspicion(info):
    """Higher = more likely mis-read. Combines small margin (ambiguous) and large
    best SSD (poor fit). Normalized so it's comparable across glyphs."""
    rs, al = info['read_ssd'], info['alt_ssd']
    amb = rs / al if al > 0 else 1.0          # ->1 means runner-up nearly as good
    return amb + min(rs / 80.0, 1.0) * 0.25   # add a poor-absolute-fit term


def crop_b64(im, cx, cy, box=84, scale=3):
    H, W, _ = im.shape
    x0, y0 = max(0, int(cx) - box // 2), max(0, int(cy) - box // 2)
    sub = im[y0:y0 + box, x0:x0 + box]
    img = Image.fromarray(sub).resize((sub.shape[1] * scale, sub.shape[0] * scale), Image.NEAREST)
    buf = io.BytesIO(); img.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sample', type=int, default=1500, help='random screenshots to scan')
    ap.add_argument('--top', type=int, default=250, help='worst N suspect digits to show')
    ap.add_argument('--glob', default='captures/g*.png')
    ap.add_argument('--out', default='ocr_audit.html')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--stats-only', action='store_true')
    a = ap.parse_args()

    files = sorted(glob.glob(a.glob))
    random.Random(a.seed).shuffle(files)
    files = files[:a.sample]
    print(f"scanning {len(files)} screenshots from {a.glob}", flush=True)

    suspects = []   # (suspicion, file, node, value, info, cx, cy)
    boards = 0
    all_susp = []
    for fi, f in enumerate(files):
        try:
            im = np.asarray(Image.open(f).convert('RGB'))
        except Exception:
            continue
        st = P.parse(f)
        if len(st['nodes']) < 25:
            continue
        boards += 1
        for n in st['nodes']:
            cx, cy = n['px'], n['py']
            value, infos = digit_details(im, cx, cy)
            for gi_, info in enumerate(infos):
                s = suspicion(info)
                all_susp.append(s)
                # also flag unusual values: 0, two-digit (>=10), or read_ssd very high
                unusual = (value == 0) or (value is not None and value >= 10)
                suspects.append((s, f, n, value, info, cx, cy, unusual))
        if (fi + 1) % 250 == 0:
            print(f"  {fi+1}/{len(files)} parsed, {boards} boards", flush=True)

    all_susp.sort()
    if all_susp:
        import statistics as stt
        print(f"\nscanned {boards} boards, {len(all_susp)} digit-glyphs")
        qs = [0.5, 0.9, 0.95, 0.99]
        for q in qs:
            print(f"  suspicion p{int(q*100)}: {all_susp[int(q*len(all_susp))-1]:.3f}")
        print(f"  max suspicion: {all_susp[-1]:.3f}")
    if a.stats_only:
        return

    # ---- categorize each suspect -------------------------------------------
    def category(s, value, info, unusual):
        rs, al = info['read_ssd'], info['alt_ssd']
        if info['read'] == 6 and info['alt'] == 4 and rs > 3 * al + 20:
            return 'A. "4" read as "6" (hole-scope bug)'
        if rs > 3 * al + 20:
            return f'B. hole-scope override: read {info["read"]}, glyph matches {info["alt"]}'
        if value is not None and value >= 10:
            return 'C. implausible two-digit read (glow/segmentation)'
        if value == 0:
            return 'D. strength-0 read (faded node)'
        if rs / al > 0.6 if al > 0 else False:
            return 'E. ambiguous (runner-up nearly as close)'
        return 'F. other'

    cats = {}
    for s, f, n, value, info, cx, cy, unusual in suspects:
        if s < 0.45 and not unusual and not (info['read_ssd'] > 3 * info['alt_ssd'] + 20):
            continue   # drop clearly-confident reads
        c = category(s, value, info, unusual)
        cats.setdefault(c, []).append((s, f, n, value, info, cx, cy, unusual))

    PER_CAT = max(12, a.top // max(1, len(cats)))
    sections = []
    for c in sorted(cats):
        items = sorted(cats[c], key=lambda t: t[0], reverse=True)
        total = len(items)
        items = items[:PER_CAT]
        cards = []
        for s, f, n, value, info, cx, cy, unusual in items:
            im = np.asarray(Image.open(f).convert('RGB'))
            b64 = crop_b64(im, cx, cy)
            cards.append(f"""
            <div class=card><img src="data:image/png;base64,{b64}">
              <div class=meta><div class=big>read <b>{value}</b></div>
              <div>nearest other: <b>{info['alt']}</b> · ssd {info['read_ssd']:.0f}/{info['alt_ssd']:.0f}</div>
              <div class=susp>susp {s:.2f}</div>
              <div class=fn>{os.path.basename(f)} · {n['owner']} r{n['row']}c{n['col']}</div></div>
            </div>""")
        sections.append(f"<h2>{c} &nbsp;<span class=cnt>({total} found, showing {len(items)})</span></h2>"
                        f"<div class=grid>{''.join(cards)}</div>")

    html = f"""<!doctype html><meta charset=utf-8><title>OCR audit</title>
<style>
 body{{background:#111;color:#ddd;font:13px/1.4 -apple-system,sans-serif;margin:16px}}
 h1{{font-size:19px}} h2{{font-size:15px;color:#9cf;margin-top:26px;border-bottom:1px solid #333;padding-bottom:4px}}
 .cnt{{color:#789;font-weight:normal;font-size:12px}}
 .grid{{display:flex;flex-wrap:wrap;gap:10px}}
 .card{{background:#1c1c1c;border:1px solid #333;border-radius:8px;padding:8px;width:300px;display:flex;gap:10px}}
 .card img{{image-rendering:pixelated;border-radius:6px;width:120px;height:120px;object-fit:cover}}
 .meta{{font-size:12px}} .big{{font-size:16px;margin-bottom:3px}} .susp{{color:#f9a}}
 .fn{{color:#789;font-size:10px;margin-top:4px;word-break:break-all}}
 .hdr{{margin-bottom:12px;color:#bbb;max-width:900px}}
</style>
<h1>OCR audit — {boards} historical boards scanned</h1>
<div class=hdr>Each card is a 3× crop of one node; "read" is what the parser produced, "nearest
other" is the next-closest digit template. Compare the number you SEE to "read". Category A is a
confirmed systematic bug (the bank's "4" template has 0 holes but the font's closed-top 4 has 1,
so the hole filter forces a "6"). Categories C/D are inherently fragile reads.</div>
{''.join(sections)}
"""
    out = os.path.join(HERE, a.out)
    open(out, 'w').write(html)
    print(f"\nwrote {out}  ({sum(len(v) for v in cats.values())} suspects across {len(cats)} categories)")
    for c in sorted(cats):
        print(f"  {c}: {len(cats[c])}")


if __name__ == '__main__':
    main()
