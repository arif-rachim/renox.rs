#!/usr/bin/env bash
# B6 first cut (issue #11): render stage only. Runs the criterion benchmark in
# bench/spike/render-bench $BENCH_RUNS times (one criterion baseline per run),
# then collect.ts adds the best B9 marshaling number from the latest B9 raw
# result and writes $BENCH_OUT. No PASS/FAIL on the full B6 target (no HTTP,
# SQLite or isolate yet); the derived check is render + marshal <= 1 ms p50.
#
# Tunables (environment): B6_WARMUP_S (3), B6_MEASURE_S (5).
set -euo pipefail

: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
runs=${BENCH_RUNS:-3}
target_dir=$(cargo metadata --format-version 1 --no-deps | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).target_directory)')
meta="$target_dir/criterion/B6-meta.json"
mkdir -p "$target_dir/criterion"

baselines=()
for run in $(seq 1 "$runs"); do
  baseline="b6-run$run"
  echo "B6 run $run/$runs (criterion baseline $baseline)" >&2
  B6_META_OUT=$meta cargo bench --quiet -p render-bench --bench render -- \
    --warm-up-time "${B6_WARMUP_S:-3}" --measurement-time "${B6_MEASURE_S:-5}" \
    --save-baseline "$baseline" >&2
  baselines+=("$baseline")
done

b9=$(find bench/results/raw -name '*-B9.json' | sort | tail -n 1)
if [[ -z $b9 ]]; then
  echo "error: no B9 raw result under bench/results/raw; run bench/run.sh B9 first" >&2
  exit 1
fi
exec bun "$here/collect.ts" "$target_dir/criterion/B6" "$meta" "$b9" "$BENCH_OUT" "${baselines[@]}"
