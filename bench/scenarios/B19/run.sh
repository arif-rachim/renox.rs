#!/usr/bin/env bash
# B19 (#255): Litestream overhead. A write-heavy tenant (one insert per
# request) on renox-worker with replication off, then on (file replica,
# 1 s sync), the same closed-loop load from bench/scenarios/B19/load.ts;
# throughput and p99 compared. Needs litestream on PATH
# (ops/scripts/fetch-litestream.sh) and a renox-worker (RENOX_WORKER_PATH,
# default target/release/renox-worker, built if missing).
#
# Tunables (environment): B19_SECONDS (30), B19_CONCURRENCY (16).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v litestream >/dev/null || { echo "error: litestream is not on PATH; run ops/scripts/fetch-litestream.sh" >&2; exit 1; }
worker=${RENOX_WORKER_PATH:-target/release/renox-worker}
if [[ ! -x $worker ]]; then
  cargo build --release --locked -q -p renox-cell --bin renox-worker
fi
exec bun "$here/load.ts" "$worker" "${BENCH_RUNS:-3}" "${B19_SECONDS:-30}" "${B19_CONCURRENCY:-16}" "$BENCH_OUT"
