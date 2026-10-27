#!/usr/bin/env bash
# B3: density (registered and warm tenants) on renox-worker (#35).
set -euo pipefail
: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
"$here/../../lib/worker.sh" build >/dev/null
exec bun "$here/../B2/density.ts" B3 "$BENCH_OUT"
