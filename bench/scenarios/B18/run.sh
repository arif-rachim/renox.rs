#!/usr/bin/env bash
# B18 (#257): node failover. A control plane (control/api on PGlite) and two
# controlled renox-workers with replication on (file replica shared by both,
# standing in for object storage) and a node listener each; a tenant on
# node 1 takes writes; node 1 is killed with SIGKILL; RTO is the time until
# the tenant answers again (now from node 2, after FO1-FO6), RPO the rows
# acknowledged before the kill that the restored file does not have.
#
# Needs: litestream on PATH (ops/scripts/fetch-litestream.sh), a renox-worker
# (RENOX_WORKER_PATH, default target/release/renox-worker), Bun.
# Two hosts: B18_NODE2_SSH=<host> runs node 2 there (O3, #158).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v litestream >/dev/null || { echo "error: litestream is not on PATH; run ops/scripts/fetch-litestream.sh" >&2; exit 1; }
worker=${RENOX_WORKER_PATH:-target/release/renox-worker}
if [[ ! -x $worker ]]; then
  cargo build --release --locked -q -p renox-cell --bin renox-worker
fi
exec bun "$here/failover.ts" "$worker" "${BENCH_RUNS:-3}" "$BENCH_OUT"
