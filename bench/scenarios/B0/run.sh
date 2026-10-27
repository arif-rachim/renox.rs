#!/usr/bin/env bash
# B0: harness self-test. Times a short sleep N times per run and writes the
# scenario contract JSON, so run.sh/report.sh can be tested without a runtime.
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
runs=${BENCH_RUNS:-1}
per_run=20
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

exec bun "$here/sleep.ts" "$runs" "$per_run" "$BENCH_OUT"
