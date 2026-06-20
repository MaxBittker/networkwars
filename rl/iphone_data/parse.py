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


def read_strengths(im, blobs, tokens):
    """Assign a strength to every node: trust Vision where it reads a digit, then
    template-match the remaining nodes against the Vision-labeled glyphs (self-
    calibrating: same font/size within one screenshot)."""
    feats = [digit_feature(im, b['px'], b['py']) for b in blobs]
    strengths = [match_digit(b['px'], b['py'], tokens) for b in blobs]

    # templates: value -> list of feature arrays (only single-glyph, narrow aspect)
    templates = {}
    for s, fa in zip(strengths, feats):
        if s is None or fa is None:
            continue
        if 1 <= s <= 9 and fa[1] < 0.95:        # single narrow glyph
            templates.setdefault(s, []).append(fa[0])

    for i, (s, fa) in enumerate(zip(strengths, feats)):
        if s is not None or fa is None:
            continue
        best, bd = None, 1e18
        for val, fs in templates.items():
            for t in fs:
                d = float(((fa[0]-t)**2).sum())
                if d < bd:
                    bd, best = d, val
        strengths[i] = best
    return strengths


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


def parse(img_path):
    im = np.asarray(Image.open(img_path).convert('RGB'))
    warnings = []
    blobs = detect_blobs(im)

    if len(blobs) < 10:   # board obscured (modal/transition) — return a clearly-invalid state
        return {'nodes': [], 'counts': {f: 0 for f in NAMES}, 'scoreboard': {},
                'grid': {'cols': 0, 'rows': 0, 'dx': 0, 'dy': 0, 'x0': 0, 'y0': 0},
                'warnings': ['board obscured (%d blobs)' % len(blobs)]}

    col_centers = cluster_axis([b['px'] for b in blobs])
    row_centers = cluster_axis([b['py'] for b in blobs])
    dx, dy = base_spacing(col_centers), base_spacing(row_centers)
    x0, y0 = col_centers[0], row_centers[0]
    for b in blobs:
        b['col'] = int(round((b['px']-x0)/dx))
        b['row'] = int(round((b['py']-y0)/dy))

    tokens = ocr_full(img_path)
    strengths = read_strengths(im, blobs, tokens)
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

    scoreboard = {f: match_digit(SCORE_X[f], SCORE_Y, tokens, max_dist=35) for f in NAMES}
    if scoreboard:
        for f in NAMES:
            if scoreboard.get(f) is not None and scoreboard[f] != counts[f]:
                warnings.append(f"count mismatch {f}: board={counts[f]} scoreboard={scoreboard[f]}")

    return {
        'nodes': [{'id': b['id'], 'col': b['col'], 'row': b['row'], 'owner': b['owner'],
                   'strength': b['strength'], 'px': round(b['px'], 1), 'py': round(b['py'], 1)}
                  for b in nodes],
        'counts': counts,
        'scoreboard': scoreboard,
        'grid': {'cols': len(col_centers), 'rows': len(row_centers),
                 'dx': round(dx, 1), 'dy': round(dy, 1), 'x0': round(x0, 1), 'y0': round(y0, 1)},
        'warnings': warnings,
    }


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'win_main.png')
    state = parse(path)
    print(json.dumps(state, indent=2))
