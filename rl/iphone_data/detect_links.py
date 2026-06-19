#!/usr/bin/env python3
"""Measure the REAL link graph from a screenshot by sampling pixels along the segment
between every candidate node pair. Compares to 8-connectivity (game.js lattice)."""
import sys, json
import numpy as np
from PIL import Image

def is_line_px(rgb):
    r, g, b = int(rgb[0]), int(rgb[1]), int(rgb[2])
    mx = max(r, g, b)
    # link dots are brighter than the dark-green background and green/teal tinted
    return mx > 55 and g >= r - 10 and g > 35 and not (r > 150 and g < 110)  # exclude saturated node colors

def link_score(im, p, q, skip=44, samples=40, perp=5):
    (x1, y1), (x2, y2) = p, q
    L = np.hypot(x2-x1, y2-y1)
    if L < 1: return 0.0
    ux, uy = (x2-x1)/L, (y2-y1)/L
    nx, ny = -uy, ux           # perpendicular
    t0, t1 = skip, L-skip
    if t1 <= t0: return 0.0
    hits = 0; n = 0
    H, W, _ = im.shape
    for s in np.linspace(t0, t1, samples):
        cx, cy = x1+ux*s, y1+uy*s
        hit = False
        for d in range(-perp, perp+1):
            xx, yy = int(round(cx+nx*d)), int(round(cy+ny*d))
            if 0 <= yy < H and 0 <= xx < W and is_line_px(im[yy, xx]):
                hit = True; break
        hits += hit; n += 1
    return hits/max(1, n)

def main(img_path, json_path):
    im = np.asarray(Image.open(img_path).convert('RGB'))
    st = json.load(open(json_path))
    nodes = st['nodes']
    pitch = st['grid']['dx']
    cells = {(n['col'], n['row']): n for n in nodes}
    real, predicted = [], []
    diag_scores, orth_scores, none_scores = [], [], []
    for i in range(len(nodes)):
        for j in range(i+1, len(nodes)):
            a, b = nodes[i], nodes[j]
            dc, dr = abs(a['col']-b['col']), abs(a['row']-b['row'])
            dist = np.hypot(a['px']-b['px'], a['py']-b['py'])
            if dist > pitch*1.6:   # only near pairs are candidates
                continue
            sc = link_score(im, (a['px'], a['py']), (b['px'], b['py']))
            king = (dc <= 1 and dr <= 1)              # 8-conn prediction
            linked = sc > 0.55
            if linked: real.append((a, b, dc, dr, round(sc, 2)))
            if king: predicted.append((a, b, dc, dr))
            kind = 'diag' if (dc == 1 and dr == 1) else ('orth' if (dc+dr == 1) else 'other')
            (diag_scores if kind == 'diag' else orth_scores if kind == 'orth' else none_scores).append(sc)

    def summ(xs):
        return f"n={len(xs)} mean={np.mean(xs):.2f} >0.55:{sum(x>0.55 for x in xs)}" if xs else "n=0"
    print("link-score by geometry:")
    print("  orthogonal (H/V):", summ(orth_scores))
    print("  diagonal        :", summ(diag_scores))
    print("  other           :", summ(none_scores))
    print(f"\nreal links detected: {len(real)}   8-conn predicted: {len(predicted)}")
    # disagreements
    realset = {(min(a['id'],b['id']),max(a['id'],b['id'])) for a,b,_,_,_ in real}
    predset = {(min(a['id'],b['id']),max(a['id'],b['id'])) for a,b,_,_ in predicted}
    print(f"in real but NOT 8-conn: {len(realset-predset)}")
    print(f"in 8-conn but NOT real: {len(predset-realset)}")
    # diagonal breakdown: which diagonals are real?
    dd = [(a,b,sc) for a,b,dc,dr,sc in real if dc==1 and dr==1]
    print(f"\ndiagonal links that ARE real: {len(dd)} of {len(diag_scores)} diagonal candidates")

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
