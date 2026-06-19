#!/bin/bash
# Network Wars iPhone-Mirroring capture/tap helper.
# Single source of truth: wininfo (CoreGraphics) -> "id x y w h" for the game window.
#   nwcap.sh shot <file.png>   # screenshot the game window (works even if occluded)
#   nwcap.sh tap  <lx> <ly>    # tap at LOGICAL window coords (capture px / 2)
#   nwcap.sh info              # print id + bounds
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
WININFO="$HERE/wininfo"
TAP_BIN="$HERE/tap"

read_win() { "$WININFO"; }   # "id x y w h"

case "$1" in
  info) read_win ;;
  place)
    # pin the game window fully onto one display — taps land in dead space if the
    # window straddles a display edge or hangs off the bottom.
    osascript -e 'tell application "iPhone Mirroring" to activate' >/dev/null 2>&1
    osascript -e 'tell application "System Events" to tell process "iPhone Mirroring" to set position of (first window whose size is {318, 701}) to {120, 100}' >/dev/null 2>&1
    sleep 0.5; read_win ;;
  shot)
    read ID X Y W H < <(read_win)
    screencapture -x -o -l"$ID" "$2"; echo "saved $2 (win $ID @ $X,$Y ${W}x${H})" ;;
  tap)
    # focus + pin on-screen, THEN read bounds, THEN tap (off-display = dead clicks)
    osascript -e 'tell application "iPhone Mirroring" to activate' >/dev/null 2>&1
    osascript -e 'tell application "System Events" to tell process "iPhone Mirroring" to set position of (first window whose size is {318, 701}) to {120, 100}' >/dev/null 2>&1
    sleep 0.5
    read ID X Y W H < <(read_win)     # fresh bounds AFTER reposition
    SX=$((X + $2)); SY=$((Y + $3))
    "$TAP_BIN" "$SX" "$SY" ;;
  tapfast)
    # NO activate/reposition/sleep — assumes the window is already pinned + frontmost
    # (call `place` once per turn). ~20ms vs ~1.2s for `tap`. Re-`place` on a miss.
    read ID X Y W H < <(read_win)
    "$TAP_BIN" $((X + $2)) $((Y + $3)) ;;
  *) echo "usage: nwcap.sh {shot <file>|tap <lx> <ly>|info}"; exit 1 ;;
esac
