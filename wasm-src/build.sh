#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="${WASM_OUT_DIR:-$root/public}"
mkdir -p "$out_dir"
export EMSDK_QUIET="${EMSDK_QUIET:-1}"

if [[ -f "$root/.tools/emsdk/emsdk_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$root/.tools/emsdk/emsdk_env.sh" >/dev/null
fi

emcc "$root/wasm-src/src/generator.cpp" \
  -std=c++17 \
  -O3 \
  --bind \
  -s WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web,worker,node \
  -s MODULARIZE=0 \
  -s EXPORT_NAME=Module \
  -o "$out_dir/generator.js"
