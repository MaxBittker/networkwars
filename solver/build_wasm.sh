#!/usr/bin/env bash
# Compile the C engine to the in-browser WASM build (public/fast_engine.js).
# Single-file ESM: the .wasm is embedded as base64, so public/ is fully static.
#
# IMPORTANT: no -ffast-math. Native uses it (and matches strict-IEEE Python board-gen),
# but on wasm32 -ffast-math makes different FP choices and breaks cross-arch board-gen
# bit-parity (~13% of seeds diverge). The C-UCT search does not need it. After building,
# verify with: python3 solver/validate_wasm.py
set -euo pipefail
cd "$(dirname "$0")/.."

emcc -O3 solver/fast_engine.c -o public/fast_engine.js \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sSINGLE_FILE=1 -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,getValue,setValue,HEAP32,HEAPF64 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_new_game,_set_topology,_get_adj,_get_links,_set_rng_mb32,_get_rng_mb32,_set_sim_seed,_use_mb32_rng,_use_sim_rng,_uct_search,_uct_begin,_uct_step,_uct_report,_uct_sims_done,_uct_set_value_stop,_resolve_battle_logged,_ext_reinforce,_bot_turn_begin,_bot_turn_next,_ext_check_winner,_ext_resolve_battle,_end_turn,_rollout

echo "built public/fast_engine.js ($(wc -c < public/fast_engine.js) bytes)"
