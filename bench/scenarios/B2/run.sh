#!/usr/bin/env bash
# B2: memory per idle tenant on renox-worker (#35).
set -euo pipefail
: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
"$here/../../lib/worker.sh" build >/dev/null
exec bun "$here/density.ts" B2 "$BENCH_OUT"
