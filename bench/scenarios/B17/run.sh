#!/usr/bin/env bash
# B17: npm compatibility inside the isolate (issue #8). Starts the Edge Runtime
# spike with examples/npm-compat staged (node_modules installed by run.sh
# --stage), calls GET /api/check on a fresh worker per run, and writes
# $BENCH_OUT. The per-package table is printed to stdout.
# Runtime mode: EDGE_RUNTIME_MODE=source|docker (default source).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }

"$here/../../edge-runtime/run.sh" --build-only >/dev/null
trap '"$here/../../edge-runtime/run.sh" --stop' EXIT
exec bun "$here/report.ts" "$BENCH_OUT"
