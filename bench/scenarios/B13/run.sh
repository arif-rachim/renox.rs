#!/usr/bin/env bash
# B13: template DoS on renox-worker (#46): the `evil` app's nested
# 10,000 x 10,000 loop page, stopped by the render limits; a sequential
# latency probe on a second tenant shows whether the node is affected.
set -euo pipefail
: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
"$here/../../lib/worker.sh" build >/dev/null
exec bun "$here/measure.ts" "$BENCH_OUT"
