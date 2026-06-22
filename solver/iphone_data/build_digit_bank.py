#!/usr/bin/env python3
"""Build the verified digit template bank (digit_bank.npy) used by parse.py's
template-matching strength reader.

Harvests single-digit glyphs from captures/*.json+png using parse.py's exact
preprocessing (_clean_mask + _segment_glyphs), labels them by the recorded
strength, and averages each digit with outlier-trimming (tight cluster). The
~5% of mislabels from the old Vision reader fall out as outliers, so the
templates stay clean. 2-digit numbers are skipped (we only need 0-9 templates;
multi-digit reads segment into single glyphs).

Run:  python build_digit_bank.py
"""
import glob
import json
import os

import numpy as np
from PIL import Image

import parse as P

HERE = os.path.dirname(os.path.abspath(__file__))


def tight_mean(feats, keep_frac=0.65, iters=4):
    fs = np.array(feats)
    m = fs.mean(0)
    for _ in range(iters):
        d = ((fs - m) ** 2).sum((1, 2))
        m = fs[d <= np.percentile(d, keep_frac * 100)].mean(0)
    return m


def main():
    from collections import defaultdict
    feats = defaultdict(list)
    boards = 0
    for jf in sorted(glob.glob(os.path.join(HERE, 'captures', 'g*_r*_*.json'))):
        pf = jf[:-5] + '.png'
        if not os.path.exists(pf):
            continue
        try:
            d = json.load(open(jf))
        except Exception:
            continue
        if sum(d['counts'].values()) != 30 or d['grid']['rows'] != 7 or d.get('recovered'):
            continue
        im = np.asarray(Image.open(pf).convert('RGB'))
        boards += 1
        for n in d['nodes']:
            s = n['strength']
            if s is None or not (0 <= s <= 9):       # single-digit only
                continue
            m = P._clean_mask(im, n['px'], n['py'])
            if m is None:
                continue
            gs = P._segment_glyphs(m)
            if len(gs) == 1:                          # one clean glyph
                feats[s].append(gs[0])

    bank = {v: tight_mean(feats[v]) for v in feats if len(feats[v]) >= 5}
    out = os.path.join(HERE, 'digit_bank.npy')
    np.save(out, bank, allow_pickle=True)
    print(f'scanned {boards} boards; bank digits {sorted(bank)}')
    print('sample counts:', {v: len(feats[v]) for v in sorted(feats)})
    print('saved', out)


if __name__ == '__main__':
    main()
