#!/usr/bin/env bash
# B9: V8 -> minijinja::Value marshaling cost (issue #10). Runs the criterion
# benchmark in bench/spike/marshal-bench $BENCH_RUNS times, each run saved as
# its own criterion baseline, then collect.ts writes $BENCH_OUT with the median
# of runs per path and size. Judged: the best path at 100 items (marshal_us).
#
# Tunables (environment): B9_WARMUP_S (3), B9_MEASURE_S (5).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
runs=${BENCH_RUNS:-3}
target_dir=$(cargo metadata --format-version 1 --no-deps | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).target_directory)')

baselines=()
for run in $(seq 1 "$runs"); do
  baseline="b9-run$run"
  echo "B9 run $run/$runs (criterion baseline $baseline)" >&2
  cargo bench --quiet -p marshal-bench --bench marshal -- \
    --warm-up-time "${B9_WARMUP_S:-3}" --measurement-time "${B9_MEASURE_S:-5}" \
    --save-baseline "$baseline" >&2
  baselines+=("$baseline")
done

exec bun "$here/collect.ts" "$target_dir/criterion/B9" "$BENCH_OUT" "${baselines[@]}"
