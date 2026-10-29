#!/usr/bin/env bash
# The fault-injection harness (#104): bench/chaos/run.sh <scenario|all> [--out <dir>]
# Scenarios: node-kill storage-down control-plane-down disk-full corrupt-file replica-lag pubsub-drop.
# Result files go to <dir> (default bench/results) as <date>-CHAOS-<scenario>.md
# with the raw JSON under <dir>/raw. Exit 1 when a scenario fails.
#
# Needs: Bun, litestream on PATH (ops/scripts/fetch-litestream.sh), a
# renox-worker (RENOX_WORKER_PATH, default target/release/renox-worker, built
# when missing). disk-full needs root (loop mounts); storage-down needs the
# RENOX_CHAOS_S3_* variables (bench/chaos/README.md).
set -euo pipefail

usage() { echo "usage: bench/chaos/run.sh <scenario|all> [--out <dir>]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
scenario=$1
shift
out=bench/results
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 ]] || usage
      out=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
command -v litestream >/dev/null || { echo "error: litestream is not on PATH; run ops/scripts/fetch-litestream.sh" >&2; exit 1; }
worker=${RENOX_WORKER_PATH:-target/release/renox-worker}
if [[ ! -x $worker ]]; then
  cargo build --release --locked -q -p renox-cell --bin renox-worker
fi
mkdir -p "$out"
exec bun bench/chaos/chaos.ts "$scenario" "$(realpath "$worker")" "$out"
