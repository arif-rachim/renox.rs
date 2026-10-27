#!/usr/bin/env bash
# B12: noisy neighbour on renox-worker (#35).
set -euo pipefail
: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
command -v oha >/dev/null 2>&1 || echo "note: oha not found (cargo install oha); using the Bun load generator" >&2
"$here/../../lib/worker.sh" build >/dev/null
exec bun "$here/measure.ts" "$BENCH_OUT"
