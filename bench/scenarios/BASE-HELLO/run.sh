#!/usr/bin/env bash
# BASE-HELLO: Bun + Hono and Node + Hono serving GET / -> {"ok":true}, for
# comparison with B1/B4/B5/B11 (docs/14-benchmarks.md, "Baselines").
# Informational: no pass/fail.
#
# Needs: bun, node (>= 22.18 for TypeScript type stripping), oha
#   (cargo install oha, or https://github.com/hatoo/oha/releases).
# Tunables (environment): BASE_WARMUP_S (30), BASE_DURATION_S (60),
#   BASE_CONNECTIONS (64), BASE_STARTUP_SAMPLES (50).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
app="$here/../../baselines/hello-hono"

for tool in bun node oha; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool not found on PATH." >&2
    [[ $tool == oha ]] && echo "install: cargo install oha (or a release binary from https://github.com/hatoo/oha/releases)" >&2
    exit 1
  fi
done

(cd "$app" && bun install --frozen-lockfile >/dev/null)
exec bun "$here/measure.ts" "$app" "$BENCH_OUT"
