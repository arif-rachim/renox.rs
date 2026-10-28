#!/usr/bin/env bash
# B16: dev loop. `renox dev` on a copy of examples/shop; edit one template
# (pages/products/index.html, the product_list fragment) and time save ->
# browser updated: the `templates` event on the dev SSE channel plus the
# fragment request the dev client then makes, as the browser would.
# Needs RENOX_WORKER_PATH (cargo build -p renox-cell --bin renox-worker).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
: "${RENOX_WORKER_PATH:?set RENOX_WORKER_PATH to a renox-worker binary}"
runs=${BENCH_RUNS:-3}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

exec bun "$here/dev-loop.ts" "$runs" "$BENCH_OUT"
