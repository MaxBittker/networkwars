# iOS Network Wars capture / play tools

Drive and record the **real** iOS Network Wars app (via macOS *iPhone Mirroring*) to
validate the C engine (`solver/fast_engine.c`) and benchmark the AI. The game window is screenshotted by
CoreGraphics window-id (works even when occluded), parsed into structured state, and
acted on with synthetic taps.

## Setup
- macOS iPhone Mirroring running with a Network Wars game on screen.
- `./build.sh` compiles the Swift helpers (`tap`, `wininfo`, `ocr`).
- Python deps (numpy, PIL) live in `../.venv`.

## Library
| file | role |
|------|------|
| `wininfo.swift`/`wininfo` | locate the game window → `id x y w h` (CGWindowBounds). Single source of truth. |
| `tap.swift`/`tap` | post a CGEvent left-click at a global screen point. |
| `ocr.swift`/`ocr` | Vision full-image OCR → `text\tcx\tcy` per string (one-shot). |
| `ocrserve.swift`/`ocrserve` | persistent Vision OCR: reads image paths on stdin, keeps Vision warm (~70ms/call vs ~240ms). `parse.py` uses this; falls back to `ocr`. |
| `nwcap.sh` | `shot <file>` / `tap <lx> <ly>` (logical = capture px / 2) / `info`. |
| `parse.py` | screenshot → state JSON: nodes `{id,col,row,owner,strength,px,py}`, counts, grid. Self-calibrating digit OCR (Vision + template-match fallback). |
| `nwmove_fast.py` | state JSON → one best RED move via the C-UCT search (`fast_engine.so` via `fastnw`). One-shot CLI; emits `winexp` + top candidates. |
| `play.py` | full game driver: capture→parse→C-UCT move→tap loop, diff-settle validation, game-over detection. |
| `series.py` | run N live games end-to-end with the C-UCT engine; logs rich JSONL + telemetry to `dashserver.py`. Never surrenders. |
| `dashserver.py` | live dashboard: receives per-move telemetry from `series.py`, renders board + winexp + search-tree. |

## Usage
```bash
./nwcap.sh shot board.png
../.venv/bin/python parse.py board.png            # -> state JSON
../.venv/bin/python nwmove_fast.py state.json --sims 8000   # -> {"action":"attack",...,"winexp":..}

# play a full game with the C-UCT engine:
../.venv/bin/python play.py --max-rounds 30 --sims 8000

# run a live series with the dashboard:
../.venv/bin/python series.py --games 20 --sims 8000
```

**Performance** (the phone, not the AI, is the bottleneck — search is ~40ms/move):
- Taps use `nwcap.sh tapfast` (~0.26s) instead of `tap` (~1.25s, which re-activates
  + repositions + sleeps every call); the window is re-pinned once per turn via
  `place()` and again only on a miss (drift). No routine deselect.
- `parse.py` `classify` is vectorized, and Vision OCR runs through a **persistent
  warm process** (`ocrserve`) instead of spawning `ocr` per call — the per-spawn
  Vision cold-start (~170ms) is paid once, so OCR drops ~240ms → ~70ms and a full
  board parse ~540ms → ~130ms (warm), with identical digit accuracy (`.accurate`).
- `capture_state` settles via cheap gray-diff polling and accepts only when TWO
  consecutive parses agree — this kills the transient wrong numbers from a node's
  count-up animation slipping under the diff threshold.

`captures/` holds recorded states (`startX.json/png`, `rN_tM.json` per round).

## Gotchas (all handled in the tools)
- Two "iPhone Mirroring" windows exist; the game one has title exactly `iPhone Mirroring`.
- The window drifts position; bounds are re-read before every tap.
- Attack gesture: tap source node (highlights), then tap adjacent enemy.
- **Parse only a settled, deselected board** — mid-animation frames and selection
  highlights corrupt the parse. `play.py` deselects, waits, and requires two identical
  consecutive parses before acting.

## Findings: real app (now matched by the C engine)
- Board is **6 cols × 7 rows** (42 cells − 12 removed = 30), not 6×6.
- **Initial strengths reach 8** at a 6/6/6/6/6 opening.
