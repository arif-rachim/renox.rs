#!/usr/bin/env bash
# Runs one benchmark scenario and prints the filled result template.
# Usage: bench/run.sh <ID> [--profile node-small|dev-laptop] [--runs N]
# Contract for scenarios: bench/scenarios/README.md.
set -euo pipefail

bench_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$bench_dir/.." && pwd)

available_ids() {
  local d ids=()
  for d in "$bench_dir"/scenarios/*/; do
    [[ -x "$d/run.sh" ]] && ids+=("$(basename "$d")")
  done
  echo "${ids[*]:-none}"
}

usage() {
  echo "usage: bench/run.sh <ID> [--profile node-small|dev-laptop] [--runs N]" >&2
  echo "available IDs: $(available_ids)" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
id=$1
shift
profile=dev-laptop
runs=3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || usage
      profile=$2
      shift 2
      ;;
    --runs)
      [[ $# -ge 2 ]] || usage
      runs=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$profile" in
  node-small | dev-laptop) ;;
  *)
    echo "error: unknown profile '$profile' (node-small or dev-laptop)" >&2
    exit 2
    ;;
esac
if ! [[ "$runs" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: --runs must be a positive integer, got '$runs'" >&2
  exit 2
fi
if ! [[ "$id" =~ ^[A-Za-z0-9_-]+$ ]] || [[ ! -x "$bench_dir/scenarios/$id/run.sh" ]]; then
  echo "error: unknown benchmark ID '$id' (no executable bench/scenarios/$id/run.sh)" >&2
  echo "available IDs: $(available_ids)" >&2
  exit 2
fi

date=$(date -u +%Y-%m-%d)
mkdir -p "$bench_dir/results/raw"
export BENCH_ID=$id
export BENCH_PROFILE=$profile
export BENCH_RUNS=$runs
export BENCH_OUT="bench/results/raw/$date-$id.json"
hw_out="bench/results/raw/$date-$id.hw.json"

cd "$repo_dir"
"$bench_dir/lib/hwinfo.sh" >"$hw_out"
rm -f "$BENCH_OUT"
echo "running $id (profile $profile, runs $runs) -> $BENCH_OUT" >&2
"$bench_dir/scenarios/$id/run.sh"
if [[ ! -s "$BENCH_OUT" ]]; then
  echo "error: scenario $id did not write $BENCH_OUT" >&2
  exit 1
fi
echo >&2
"$bench_dir/lib/report.sh" "$BENCH_OUT" "$hw_out"
