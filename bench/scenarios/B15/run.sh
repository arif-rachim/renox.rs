#!/usr/bin/env bash
# B15: deploy and rollback end to end against a local control plane (#60).
# Starts control/api (on RENOX_TEST_PG when set, else in-process PGlite with
# the in-memory artifact store) and a controlled renox-worker, then times
# `renox deploy` of a fresh copy of examples/shop (bundle, upload, validate,
# activate, first 200 from the worker) and `renox deploy --rollback`, with the
# stage breakdown of `renox deploy --json`. Runs: BENCH_RUNS (5 recommended).
# Needs RENOX_WORKER_PATH (cargo build -p renox-cell --bin renox-worker).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
: "${RENOX_WORKER_PATH:?set RENOX_WORKER_PATH to a renox-worker binary}"
runs=${BENCH_RUNS:-5}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

exec bun "$here/deploy.ts" "$runs" "$BENCH_OUT"
