#!/usr/bin/env bash
# B5: hello function latency.
#   default (F1, #35): on renox-worker, the same closed-loop load as B11
#     (bench/scenarios/B11/load-scenario.ts) plus 1,000 sequential requests.
#   B5_RUNTIME=edge: the F0 measurement on the Edge Runtime spike (#7).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }

if [[ "${B5_RUNTIME:-worker}" == "edge" ]]; then
  "$here/../../edge-runtime/run.sh" --build-only >/dev/null
  trap '"$here/../../edge-runtime/run.sh" --stop' EXIT
  exec bun "$here/measure.ts" "$BENCH_OUT"
fi
command -v oha >/dev/null 2>&1 || echo "note: oha not found (cargo install oha); using the Bun load generator" >&2
"$here/../../lib/worker.sh" build >/dev/null
exec bun "$here/../B11/load-scenario.ts" B5 "$BENCH_OUT"
