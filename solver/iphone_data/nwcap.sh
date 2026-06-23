#!/bin/bash
# Network Wars iPhone-Mirroring capture/tap helper.
# Single source of truth: wininfo (CoreGraphics) -> "id x y w h" for the game window.
#   nwcap.sh shot <file.png>   # screenshot the game window (works even if occluded)
#   nwcap.sh tap  <lx> <ly>    # tap at LOGICAL window coords (capture px / 2)
#   nwcap.sh info              # print id + bounds
#
# Window-info cache: `wininfo` (Swift CGWindowList) costs ~0.2s and was re-run on
# EVERY shot/tap. The window is pinned by `place`/`tap`, so those refresh a cache
# (.wincache) and `shot`/`tapfast` read it — saving ~0.2s per call (lots of calls
# per move). The cache self-heals: a stale id makes `shot` fail -> empty file ->
# the driver re-`place`s (which refreshes the cache).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
WININFO="$HERE/wininfo"
TAP_BIN="$HERE/tap"
CACHE="$HERE/.wincache"

read_win() { "$WININFO"; }   # live "id x y w h"

cached_win() {               # cached bounds; fall back to live + populate cache
  if [ -s "$CACHE" ]; then cat "$CACHE"; else read_win | tee "$CACHE"; fi
}

pin() {                      # activate + reposition fully on-screen
  # System Events window queries can hang when iPhone Mirroring is reconnecting.
  # Keep this path non-blocking; wininfo supplies the current CG window bounds.
  open -a "iPhone Mirroring" >/dev/null 2>&1 || true
  sleep 0.2
}

case "$1" in
  info) read_win ;;
  place)
    # pin the game window fully onto one display, then refresh the bounds cache
    pin
    W=$(read_win); echo "$W" > "$CACHE"; echo "$W" ;;
  shot)
    # only the window ID matters (screencapture -l grabs it wherever it sits)
    read ID X Y W H < <(cached_win)
    screencapture -x -o -l"$ID" "$2"; echo "saved $2 (win $ID @ $X,$Y ${W}x${H})" ;;
  tap)
    # focus + pin on-screen, refresh cache, THEN tap (off-display = dead clicks)
    pin
    read ID X Y W H < <(read_win)     # fresh bounds AFTER reposition
    echo "$ID $X $Y $W $H" > "$CACHE"
    "$TAP_BIN" $((X + $2)) $((Y + $3)) ;;
  tapfast)
    # NO activate/reposition — uses cached bounds (window pinned by `place`/`tap`).
    read ID X Y W H < <(cached_win)
    "$TAP_BIN" $((X + $2)) $((Y + $3)) ;;
  *) echo "usage: nwcap.sh {shot <file>|tap <lx> <ly>|info|place|tapfast}"; exit 1 ;;
esac
