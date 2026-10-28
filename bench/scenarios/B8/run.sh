#!/usr/bin/env bash
# B8 (#42): render path A (Rust, minijinja, after marshaling) against path B
# (the template compiled to JavaScript by renox-template emit_js, rendered in
# the isolate), end to end on renox-worker with the shop list page.
#
# Stages a copy of examples/shop under target/bench-b8/ (its node_modules a
# link to the shop's, so its npm dependencies resolve) with the overlay/ files: a page
# /b8 (path A, the products page template) and a function /b8/render
# (path B, the same loader and template). Then measure.ts runs both.
set -euo pipefail
: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../../.." && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "error: cargo is required (https://rustup.rs)" >&2; exit 1; }

RENOX_WORKER_PATH=$("$repo/bench/lib/worker.sh" build)
export RENOX_WORKER_PATH

stage="$repo/target/bench-b8/shop-b8"
rm -rf "$stage"
mkdir -p "$(dirname "$stage")"
cp -R "$repo/examples/shop" "$stage"
# The shop's tests are not needed and would be found by `bun test`.
rm -rf "$stage/node_modules" "$stage/.renox" "$stage/tests"
ln -s "$repo/examples/shop/node_modules" "$stage/node_modules"
cp -R "$here/overlay/." "$stage/"
cp "$repo/examples/shop/pages/products/index.html" "$stage/pages/b8/index.html"
(cd "$repo" && cargo run --quiet --release -p renox-template --example emit_js -- "$stage") >"$stage/lib/b8-templates.mjs"

exec bun "$here/measure.ts" "$BENCH_OUT" "$stage"
