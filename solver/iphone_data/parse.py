#!/usr/bin/env python3
"""Parse a Network Wars iPhone-Mirroring screenshot into structured game state.

Output (JSON to stdout):
  {
    "nodes": [{"id","col","row","owner","strength","px","py"}],   # px,py = full-res pixel center
    "counts": {faction: n},            # from detected board nodes
    "scoreboard": {faction: n|null},   # from the top chips (ground-truth cross-check)
    "grid": {"cols","rows","dx","dy","x0","y0"},
    "warnings": [...]
  }

Node ids follow the engine convention: survivors sorted by (row, col).
Adjacency is NOT emitted here; reconstruct it from (col,row) 8-connectivity.
"""
import sys, os, json, subprocess
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OCR = os.path.join(HERE, "ocr")

FACTIONS = {
    'red':    (217,  64,  90),
    'green':  ( 46, 193, 110),
    'yellow': (212, 160,  23),
    'blue':   ( 58, 123, 213),
    'purple': (155,  89, 217),
}
NAMES = list(FACTIONS)

# board region of the 636x1402 capture (excludes top scoreboard + bottom buttons)
BOARD_Y0, BOARD_Y1 = 380, 1240
MIN_BLOB = 450          # downsampled-px area; real nodes ~600-1100, artifacts <300
# overlay/modal rejection: a popup ("You Lost! / Play again?", round-end, transition)
# is a big near-black flat rounded-rect over the board. The parser otherwise
# force-parses the occluded board into a garbage 30-node state (hallucinated owners
# /strengths, impossible faction counts). Such a frame's board region is ~34%
# near-black-and-flat pixels vs ~5% for a clean board (huge gap, no overlap on 400
# sampled frames) — reject above MODAL_DARKFLAT.
MODAL_DARKFLAT = 0.20
SCORE_Y = 222           # scoreboard chip row in the 636x1402 capture
SCORE_X = {'red': 225, 'green': 302, 'yellow': 380, 'blue': 458, 'purple': 535}


def classify(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    if mx < 70 or (mx - mn) < 40:
        return -1
    best, bd = -1, 1 << 30
    for i, c in enumerate(FACTIONS.values()):
        d = (r-c[0])**2 + (g-c[1])**2 + (b-c[2])**2
        if d < bd:
            bd, best = d, i
    return best


def classify_array(ds):
    """Vectorized classify over an HxWx3 uint8 array → int8 label map (-1 = none).
    ~30x faster than the per-pixel Python loop."""
    a = ds.astype(np.int32)
    mx = a.max(2)
    mn = a.min(2)
    valid = (mx >= 70) & ((mx - mn) >= 40)
    best = np.full(a.shape[:2], -1, dtype=np.int8)
    bd = np.full(a.shape[:2], 1 << 30, dtype=np.int64)
    for i, c in enumerate(FACTIONS.values()):
        d = (a[:, :, 0]-c[0])**2 + (a[:, :, 1]-c[1])**2 + (a[:, :, 2]-c[2])**2
        m = d < bd
        bd = np.where(m, d, bd)
        best = np.where(m, i, best).astype(np.int8)
    best[~valid] = -1
    return best


def components(mask):
    H, W = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    ys, xs = np.where(mask)
    pset = set(zip(ys.tolist(), xs.tolist()))
    out = []
    for y0, x0 in list(pset):
        if seen[y0, x0]:
            continue
        stack = [(y0, x0)]; seen[y0, x0] = True; comp = []
        while stack:
            y, x = stack.pop(); comp.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y+dy, x+dx
                if 0 <= ny < H and 0 <= nx < W and not seen[ny, nx] and (ny, nx) in pset:
                    seen[ny, nx] = True; stack.append((ny, nx))
        out.append(comp)
    return out


def cluster_axis(vals, tol=40):
    """Cluster 1D values; return sorted list of cluster means."""
    s = sorted(vals)
    if not s:
        return []
    groups = [[s[0]]]
    for v in s[1:]:
        if v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [sum(g)/len(g) for g in groups]


def base_spacing(centers):
    """Minimal gap between consecutive cluster centers (the grid pitch)."""
    if len(centers) < 2:
        return 1.0
    gaps = [b-a for a, b in zip(centers, centers[1:])]
    return min(gaps)


FRAG_FLOOR = 5        # min ds-px for a fragment to count (drops 1-4px AA specks)
MERGE_RADIUS = 28     # ds-px; a node's own arcs are within ~22px, neighbors ~49px apart


def detect_blobs(im):
    ds = im[::2, ::2]
    h, w, _ = ds.shape
    lbl = classify_array(ds)
    blobs = []
    for fi in range(len(NAMES)):
        mask = lbl == fi
        if not mask.any():
            continue
        # collect every fragment (the central white digit can split one node's
        # ring into several arcs, each below MIN_BLOB — e.g. faded strength-0 nodes)
        frags = []
        for comp in components(mask):
            if len(comp) < FRAG_FLOOR:
                continue
            ys = np.fromiter((p[0] for p in comp), float)
            xs = np.fromiter((p[1] for p in comp), float)
            frags.append({'cy': ys.mean(), 'cx': xs.mean(), 'n': len(comp)})
        # greedily merge fragments that belong to the same node (close together),
        # but not adjacent nodes (a full grid pitch apart)
        clusters = []
        for f in sorted(frags, key=lambda z: -z['n']):
            for cl in clusters:
                if abs(f['cy'] - cl['cy']) < MERGE_RADIUS and abs(f['cx'] - cl['cx']) < MERGE_RADIUS:
                    tot = cl['n'] + f['n']
                    cl['cy'] = (cl['cy'] * cl['n'] + f['cy'] * f['n']) / tot
                    cl['cx'] = (cl['cx'] * cl['n'] + f['cx'] * f['n']) / tot
                    cl['n'] = tot
                    break
            else:
                clusters.append(dict(f))
        for cl in clusters:
            if cl['n'] < MIN_BLOB:
                continue
            cy, cx = cl['cy'] * 2, cl['cx'] * 2
            if cy < BOARD_Y0 or cy > BOARD_Y1:
                continue
            blobs.append({'owner': NAMES[fi], 'px': cx, 'py': cy, 'size': cl['n']})
    return blobs


OCRSERVE = os.path.join(HERE, "ocrserve")
_OCR_PROC = None


def _ocr_proc():
    """Lazily start a persistent Vision OCR coprocess (ocrserve). Keeping Vision
    warm across images costs ~70ms/call vs ~240ms for a fresh `ocr` spawn."""
    global _OCR_PROC
    if _OCR_PROC is None or _OCR_PROC.poll() is not None:
        _OCR_PROC = subprocess.Popen([OCRSERVE], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, bufsize=1)
    return _OCR_PROC


def _parse_tokens(lines):
    toks = []
    for line in lines:
        parts = line.rstrip("\n").split("\t")
        if len(parts) != 3:
            continue
        try:
            toks.append((parts[0], float(parts[1]), float(parts[2])))
        except ValueError:
            pass
    return toks


def ocr_full(img_path):
    """Vision OCR via the warm coprocess; returns list of (text, cx, cy). Falls
    back to a one-shot `ocr` spawn if the coprocess is unavailable."""
    if os.path.exists(OCRSERVE):
        try:
            p = _ocr_proc()
            p.stdin.write(img_path + "\n")
            p.stdin.flush()
            lines = []
            while True:
                line = p.stdout.readline()
                if line == "":            # coprocess died
                    raise BrokenPipeError("ocrserve closed")
                if line == "\x01\n":      # end-of-image sentinel
                    break
                lines.append(line)
            return _parse_tokens(lines)
        except (BrokenPipeError, OSError):
            global _OCR_PROC
            _OCR_PROC = None              # force restart next call; fall through to one-shot
    out = subprocess.run([OCR, img_path], capture_output=True, text=True).stdout
    return _parse_tokens(out.strip().split("\n"))


FEAT_W, FEAT_H = 18, 26   # normalized digit-glyph size for template matching


def digit_feature(im, cx, cy, box=58):
    """Isolate the white digit glyph at (cx,cy); return a normalized binary feature
    (FEAT_H x FEAT_W float array) or None if no glyph found."""
    from PIL import Image as PImage
    H, W, _ = im.shape
    x0, y0 = max(0, int(cx)-box//2), max(0, int(cy)-box//2)
    crop = im[y0:y0+box, x0:x0+box]
    white = (crop[:, :, 0] > 165) & (crop[:, :, 1] > 165) & (crop[:, :, 2] > 165)
    if white.sum() < 12:
        return None
    ys, xs = np.where(white)
    # keep glyph near crop center (drop stray specks from neighbors/glow)
    cyc, cxc = crop.shape[0]/2, crop.shape[1]/2
    keep = (np.abs(ys-cyc) < box*0.42) & (np.abs(xs-cxc) < box*0.42)
    ys, xs = ys[keep], xs[keep]
    if len(ys) < 12:
        return None
    y1, y2, x1, x2 = ys.min(), ys.max()+1, xs.min(), xs.max()+1
    glyph = white[y1:y2, x1:x2]
    img = PImage.fromarray((glyph*255).astype(np.uint8)).resize((FEAT_W, FEAT_H), PImage.BILINEAR)
    f = np.asarray(img, dtype=np.float32) / 255.0
    return (f, (x2-x1) / max(1, (y2-y1)))   # feature + aspect ratio


# ---- template-matching digit reader (primary) -----------------------------
# Pipeline per node: crop -> white-threshold -> circular border mask -> keep the
# central connected component(s) (drops the node-ring dash) -> gap-segment into
# per-digit glyphs -> match each against a verified font-stable template bank.
# This is far more accurate than Vision OCR, which misreads ~5% of digits
# (6/0, 2/7, 9/0, 1/4 ...). Bank built offline by build_digit_bank().
TM_R = 36                      # crop half-size (px) around a node center
TM_GH, TM_GW = 30, 20          # normalized single-glyph size
_yy, _xx = np.mgrid[-TM_R:TM_R, -TM_R:TM_R]
TM_CMASK = np.sqrt(_xx**2 + _yy**2) < (TM_R * 0.80)   # border/glow mask

def _holes(g, thr=0.5):
    """Count enclosed background regions in a normalized glyph (topology cue):
    8 has 2, {0,6,9} have 1, {1,2,3,4,5,7} have 0. Robust to the 0/8 (and 4/6/8)
    confusions that pure template SSD gets wrong."""
    b = g < thr                                  # background = dark
    H, W = b.shape
    seen = np.zeros_like(b)
    stack = []
    for x in range(W):
        for y in (0, H - 1):
            if b[y, x] and not seen[y, x]:
                seen[y, x] = True; stack.append((y, x))
    for y in range(H):
        for x in (0, W - 1):
            if b[y, x] and not seen[y, x]:
                seen[y, x] = True; stack.append((y, x))
    while stack:                                  # flood-fill background from the border
        y, x = stack.pop()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and b[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True; stack.append((ny, nx))
    enc = b & ~seen                               # background unreachable from outside = holes
    nh = 0; vis = np.zeros_like(enc)
    for y0 in range(H):
        for x0 in range(W):
            if enc[y0, x0] and not vis[y0, x0]:
                nh += 1; vis[y0, x0] = True; st = [(y0, x0)]
                while st:
                    y, x = st.pop()
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < H and 0 <= nx < W and enc[ny, nx] and not vis[ny, nx]:
                            vis[ny, nx] = True; st.append((ny, nx))
    return nh


_DIGIT_BANK = None
_BANK_HOLES = None
def _bank():
    global _DIGIT_BANK, _BANK_HOLES
    if _DIGIT_BANK is None:
        p = os.path.join(HERE, 'digit_bank.npy')
        _DIGIT_BANK = np.load(p, allow_pickle=True).item() if os.path.exists(p) else {}
        _BANK_HOLES = {v: _holes(_DIGIT_BANK[v]) for v in _DIGIT_BANK}
    return _DIGIT_BANK


TM_GLOW_MAX = 550   # white-px ceiling; a real digit is <~400, a selection glow >~900
# Hole-count is only consulted when the 2nd-best SSD is within this factor of the
# best (a genuine toss-up, e.g. 0-vs-8 at 35 vs 32). A decisive pixel winner
# (e.g. 4-vs-6 at 6 vs 226, ratio ~38) keeps its SSD pick and ignores holes.
TM_HOLE_TIE = 1.3


def _clean_mask(im, cx, cy):
    """White digit, border-masked, central components only (drops the ring dash).
    Returns None for a SELECTED/glowing node — its bright halo floods the white
    mask (and inverts the digit to dark), so it's unreadable; the caller then
    deselects and re-reads rather than trusting a garbage number."""
    cx, cy = int(cx), int(cy)
    box = im[cy-TM_R:cy+TM_R, cx-TM_R:cx+TM_R]
    if box.shape[:2] != (2*TM_R, 2*TM_R):
        return None
    w = ((box[:, :, 0] > 150) & (box[:, :, 1] > 150) & (box[:, :, 2] > 150)) & TM_CMASK
    if w.sum() > TM_GLOW_MAX:          # selection glow floods the mask -> unreadable
        return None
    keep = np.zeros_like(w)
    for comp in components(w):
        ys = np.fromiter((p[0] for p in comp), int)
        if len(comp) >= 12 and (np.abs(ys - TM_R) < 0.42 * TM_R).any():
            for y, x in comp:
                keep[y, x] = True
    return keep if keep.any() else w


def _norm_glyph(g):
    ys, xs = np.where(g)
    if len(ys) < 8:
        return None
    sub = g[ys.min():ys.max()+1, xs.min():xs.max()+1]
    return np.asarray(Image.fromarray((sub*255).astype(np.uint8)).resize((TM_GW, TM_GH)),
                      dtype=np.float32) / 255.0


def _segment_glyphs(m):
    """Split a clean mask into per-digit normalized glyphs by empty-column gaps
    (>=2 cols). Caps at the 2 widest segments (guards selection-glow over-split)."""
    ys, xs = np.where(m)
    if len(ys) < 8:
        return []
    x0, x1 = xs.min(), xs.max()
    colhas = (m[:, x0:x1+1].sum(0) > 1)
    segs, run, gap = [], None, 0
    for i, h in enumerate(colhas):
        if h:
            run = [i, i] if run is None else [run[0], i]
            gap = 0
        else:
            gap += 1
            if run is not None and gap >= 2:
                segs.append(tuple(run)); run = None
    if run is not None:
        segs.append(tuple(run))
    if len(segs) <= 1:
        g = _norm_glyph(m)
        return [g] if g is not None else []
    if len(segs) > 2:                          # keep the 2 widest (left-to-right)
        segs = sorted(sorted(segs, key=lambda s: s[1]-s[0])[-2:])
    out = []
    for a, b in segs:
        sub = m.copy(); sub[:, :x0+a] = False; sub[:, x0+b+1:] = False
        g = _norm_glyph(sub)
        if g is not None:
            out.append(g)
    return out


def read_strength_tm(im, cx, cy):
    """Read one node's strength. THE strategy = per-digit template matching:
    crop -> threshold -> border mask -> central component -> gap-segment into
    digits -> match each glyph to the nearest bank template.

    The match is nearest-template by pixel SSD. Enclosed-hole count (8->2,
    {0,6,9}->1, {1,2,3,4,5,7}->0) is used ONLY as a tie-break when the top-2 SSDs
    are close: holes are the one cue separating 0 from 8 (a ~2-row crossbar that
    unweighted global SSD can't reliably see), but they are a fragile topological
    feature, so a DECISIVE pixel winner must override them. Hard hole-scoping used
    to misread a closed-top "4" (which traps a phantom hole) as "6" -- SSD said 4
    by a margin of ~40x, but holes vetoed it. Now pixels win when decisive; holes
    only break genuine near-ties. Returns None if unreadable."""
    bank = _bank()
    if not bank:
        return None
    m = _clean_mask(im, cx, cy)
    if m is None:
        return None
    glyphs = _segment_glyphs(m)
    if not glyphs:
        return None
    vals = sorted(bank)
    digits = []
    for g in glyphs:
        ssd = {v: float(((g - bank[v]) ** 2).sum()) for v in vals}
        order = sorted(vals, key=lambda v: ssd[v])
        best, second = order[0], order[1]
        if ssd[second] > TM_HOLE_TIE * ssd[best]:
            digits.append(best)               # decisive pixel match -> trust SSD
        else:                                  # near-tie -> let hole topology decide
            h = _holes(g)
            cands = [v for v in vals if _BANK_HOLES.get(v) == h]
            digits.append(min(cands, key=lambda v: ssd[v]) if cands else best)
    return int(''.join(str(d) for d in digits))


def read_strengths(im, blobs):
    """Read every node's strength with the ONE strategy: per-digit template
    matching (see read_strength_tm). Requires digit_bank.npy."""
    return [read_strength_tm(im, b['px'], b['py']) for b in blobs]


def dominant_owner(im, cx, cy, dx):
    """Most common faction color in a box around (cx,cy), ignoring white/dark pixels
    (selection glow + the central digit classify as -1). None if no faction dominates."""
    H, W, _ = im.shape
    rad = int(dx * 0.32)
    x0, y0 = max(0, int(cx) - rad), max(0, int(cy) - rad)
    crop = im[y0:int(cy) + rad, x0:int(cx) + rad]
    if crop.size == 0:
        return None
    lbl = classify_array(crop[np.newaxis, ::1, ::1][0])  # HxW int8, -1 = none
    counts = np.bincount(lbl[lbl >= 0].ravel(), minlength=len(NAMES)) if (lbl >= 0).any() else None
    if counts is None or counts.max() < 40:              # too few colored px -> a hole
        return None
    return NAMES[int(counts.argmax())]


def recover_missing(im, nodes, grid):
    """Find nodes the blob detector missed (e.g. a SELECTED node whose highlight
    breaks its colored ring). A missing grid cell is a real node iff it has a white
    digit glyph AND a dominant faction color; a removed cell (hole) has neither."""
    have = {(n['row'], n['col']) for n in nodes}
    x0, y0, dx, dy = grid['x0'], grid['y0'], grid['dx'], grid['dy']
    out = []
    for r in range(grid['rows']):
        for c in range(grid['cols']):
            if (r, c) in have:
                continue
            cx, cy = x0 + c * dx, y0 + r * dy
            if cy < BOARD_Y0 or cy > BOARD_Y1:
                continue
            if digit_feature(im, cx, cy) is None:        # no number -> genuine hole
                continue
            owner = dominant_owner(im, cx, cy, dx)
            if owner is None:
                continue
            out.append({'owner': owner, 'px': float(cx), 'py': float(cy),
                        'size': MIN_BLOB, 'row': r, 'col': c, 'recovered': True})
    return out


def match_digit(cx, cy, tokens, max_dist=45):
    """Nearest single-/multi-digit token whose center is within max_dist of (cx,cy)."""
    best, bd = None, max_dist**2
    for txt, tx, ty in tokens:
        digits = ''.join(ch for ch in txt if ch.isdigit())
        if not digits:
            continue
        d = (tx-cx)**2 + (ty-cy)**2
        if d < bd:
            bd, best = d, digits
    return int(best) if best is not None else None


def modal_darkflat(im):
    """fraction of the board region that is near-black AND flat (low saturation) —
    the signature of a popup/modal fill. ~0.34 for modal frames, ~0.05 for clean."""
    reg = im[BOARD_Y0:BOARD_Y1, :, :].astype(np.int16)
    mx = reg.max(axis=2); mn = reg.min(axis=2)
    return float(((mx < 32) & ((mx - mn) < 14)).mean())


def parse(img_path):
    im = np.asarray(Image.open(img_path).convert('RGB'))
    warnings = []

    def obscured(reason):   # clearly-invalid state callers can detect + skip
        return {'nodes': [], 'counts': {f: 0 for f in NAMES}, 'scoreboard': {},
                'grid': {'cols': 0, 'rows': 0, 'dx': 0, 'dy': 0, 'x0': 0, 'y0': 0},
                'warnings': [reason]}

    # reject overlay/modal frames BEFORE parsing — they occlude the board and the
    # blob detector would otherwise hallucinate a full (wrong) board around them.
    df = modal_darkflat(im)
    if df > MODAL_DARKFLAT:
        return obscured('overlay/modal frame rejected (darkflat %.0f%%)' % (df * 100))

    blobs = detect_blobs(im)
    if len(blobs) < 10:   # board obscured another way (transition / partial)
        return obscured('board obscured (%d blobs)' % len(blobs))

    col_centers = cluster_axis([b['px'] for b in blobs])
    row_centers = cluster_axis([b['py'] for b in blobs])
    dx, dy = base_spacing(col_centers), base_spacing(row_centers)
    x0, y0 = col_centers[0], row_centers[0]
    for b in blobs:
        b['col'] = int(round((b['px']-x0)/dx))
        b['row'] = int(round((b['py']-y0)/dy))

    # recover nodes the blob detector missed (e.g. a selected/highlighted node)
    grid0 = {'cols': len(col_centers), 'rows': len(row_centers),
             'dx': dx, 'dy': dy, 'x0': x0, 'y0': y0}
    recovered = recover_missing(im, blobs, grid0)
    n_recovered = len(recovered)
    if recovered:
        blobs = blobs + recovered   # NOT a warning — recovery is a successful detection

    strengths = read_strengths(im, blobs)   # template matching — no Vision OCR needed
    for b, s in zip(blobs, strengths):
        b['strength'] = s
        if s is None:
            warnings.append(f"unreadable strength at col{b['col']} row{b['row']} ({b['owner']})")

    # dedupe: if two blobs map to the same cell, keep the larger
    by_cell = {}
    for b in blobs:
        k = (b['row'], b['col'])
        if k not in by_cell or b['size'] > by_cell[k]['size']:
            by_cell[k] = b
    nodes = sorted(by_cell.values(), key=lambda b: (b['row'], b['col']))
    for i, b in enumerate(nodes):
        b['id'] = i

    counts = {f: 0 for f in NAMES}
    for b in nodes:
        counts[b['owner']] += 1

    # Scoreboard OCR dropped: template matching reads the board reliably, and the
    # top-chip Vision OCR was flaky (misreads) AND ~77ms/parse — pure overhead now.
    return {
        'nodes': [{'id': b['id'], 'col': b['col'], 'row': b['row'], 'owner': b['owner'],
                   'strength': b['strength'], 'px': round(b['px'], 1), 'py': round(b['py'], 1)}
                  for b in nodes],
        'counts': counts,
        'grid': {'cols': len(col_centers), 'rows': len(row_centers),
                 'dx': round(dx, 1), 'dy': round(dy, 1), 'x0': round(x0, 1), 'y0': round(y0, 1)},
        'warnings': warnings,
        'recovered': n_recovered,
    }


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'win_main.png')
    state = parse(path)
    print(json.dumps(state, indent=2))
