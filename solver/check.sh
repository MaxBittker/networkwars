#!/usr/bin/env bash
# Rebuild both engines and run the gameplay, search, replay, and UI gates.
set -euo pipefail
cd "$(dirname "$0")/.."

bash solver/build_native.sh
bash solver/build_wasm.sh

check_dir=$(mktemp -d "${TMPDIR:-/tmp}/nw-check.XXXXXX")
trap 'rm -rf "$check_dir"' EXIT
for gate in math rules; do
  cc -O2 -Wall -Wextra "solver/${gate}_gate.c" -lm -o "$check_dir/$gate"
  "$check_dir/$gate"
done

for gate in validate_fast validate_wasm legacy_rules_gate site_gate; do
  uv run --project solver python "solver/$gate.py"
done

for gate in board projection skill review_scheduler rules_worker; do
  node "solver/${gate}_gate.mjs"
done
node solver/worker_gate.mjs 40
node solver/review_gate.mjs 11 4
git diff --check
