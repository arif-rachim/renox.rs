#!/usr/bin/env bash
# Builds the transpiler as a Wasm module for the CLI (#43) and copies it to
# cli/wasm/renox_template.wasm (not committed; `renox build` looks there).
# Needs: rustup target add wasm32-unknown-unknown
set -euo pipefail
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$repo_dir"
cargo rustc -p renox-template --release --no-default-features --features compiler \
  --target wasm32-unknown-unknown --crate-type cdylib
mkdir -p cli/wasm
cp target/wasm32-unknown-unknown/release/renox_template.wasm cli/wasm/renox_template.wasm
ls -l cli/wasm/renox_template.wasm
