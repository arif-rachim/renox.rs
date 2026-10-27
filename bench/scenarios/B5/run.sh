#!/usr/bin/env bash
# B5: hello function warm latency (informational, recorded by issue #7).
# Starts the Edge Runtime spike and times 1,000 sequential warm requests to
# one pinned worker per run. Writes $BENCH_OUT.
# Runtime mode: EDGE_RUNTIME_MODE=source|docker (default source).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }

"$here/../../edge-runtime/run.sh" --build-only >/dev/null
trap '"$here/../../edge-runtime/run.sh" --stop' EXIT
exec bun "$here/measure.ts" "$BENCH_OUT"
