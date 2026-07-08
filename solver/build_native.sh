#!/bin/bash
# Native engine build with PGO: instrument -> profile a few searches -> rebuild.
# Play is bit-identical to the plain -O3 build (PGO only changes code layout;
# verified move-for-move on the fixed-seed fmcts benchmark) but ~3% faster on
# Apple Silicon. Falls back to the plain one-liner if llvm-profdata is missing.
# WASM is separate and must NOT use this (see build_wasm.sh).
set -e
cd "$(dirname "$0")"
FLAGS="-O3 -ffast-math -shared -fPIC"
if xcrun -f llvm-profdata >/dev/null 2>&1; then
    cc $FLAGS -fprofile-instr-generate fast_engine.c -o fast_engine.so
    LLVM_PROFILE_FILE=/tmp/nw_fe.profraw \
        uv run python fmcts.py --games 3 --sims 4000 --seed-base 11 >/dev/null
    xcrun llvm-profdata merge -output /tmp/nw_fe.profdata /tmp/nw_fe.profraw
    cc $FLAGS -fprofile-instr-use=/tmp/nw_fe.profdata fast_engine.c -o fast_engine.so
    echo "built fast_engine.so (PGO)"
else
    cc $FLAGS fast_engine.c -o fast_engine.so
    echo "built fast_engine.so (plain -O3; llvm-profdata not found)"
fi
