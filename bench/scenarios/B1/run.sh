#!/usr/bin/env bash
# B1: memory per warm isolate (issue #6). Starts the Edge Runtime spike
# (bench/edge-runtime/run.sh) once per app × N × run, creates N pinned user
# workers, and writes the RSS delta per worker to $BENCH_OUT.
# Runtime mode: EDGE_RUNTIME_MODE=source|docker (default source).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }

"$here/../../edge-runtime/run.sh" --build-only >/dev/null
trap '"$here/../../edge-runtime/run.sh" --stop' EXIT
exec bun "$here/measure.ts" "$BENCH_OUT"
