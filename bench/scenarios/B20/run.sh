#!/usr/bin/env bash
# B20: renox-worker release binary size and CI time (issue #36). Reads,
# through the GitHub REST API (`gh api`), the job timings of the last
# $BENCH_RUNS successful CI runs on main in which the rust job ran, and the
# size of the newest renox-worker release asset. Builds nothing.
# collect.ts writes $BENCH_OUT.
#
# Needs `gh` logged in (`gh auth login`) with read access to the repository.
# Tunables (environment): B20_REPO (default: the origin remote),
# B20_BRANCH (main), B20_TARGET (x86_64-unknown-linux-gnu).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v gh >/dev/null || {
  echo "B20 needs the GitHub CLI: https://cli.github.com" >&2
  exit 1
}

exec bun "$here/collect.ts" "$BENCH_OUT" "${BENCH_RUNS:-3}"
