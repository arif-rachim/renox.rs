#!/usr/bin/env bash
# One step of the shop isolate RSS bisect (#457).
#
#   bench/rss-bisect/measure.sh <commit>
#
# Builds <commit>'s renox-worker (release, no debug info, shared target dir),
# runs B1 on shop at N = 100 from a worktree of <commit> with HEAD's bench/
# copied over it and the free tier's CPU limit raised to 1000 ms, and prints
#
#   rss-bisect <sha> rss_mb=<n> pss_mb=<n> v8_heap_mb=<n>
#
# The same line, tab-separated, is appended to steps.tsv next to this script.
# Kept between steps: .cache/<sha>/renox-worker (a cached worker skips the
# build), .cache/<sha>/B1.json (the run's raw summary), .cache/v8/ (the
# verified rusty_v8 archive; v8 is 150.4.0 at every step) and .target/.
# The worktree (.wt/<short-sha>) is removed at the end. Nothing else is
# deleted: below 15 GB of free disk the script stops (exit 2).
set -euo pipefail

[[ $# -eq 1 ]] || {
  echo "usage: bench/rss-bisect/measure.sh <commit>" >&2
  exit 2
}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)

free_gb=$(df --output=avail -B1G / | tail -n 1 | tr -d ' G')
if ((free_gb < 15)); then
  echo "free disk: delete target/debug first (${free_gb} GB free, 15 GB needed)" >&2
  exit 2
fi

sha=$(git -C "$repo" rev-parse --verify "$1^{commit}")
short=$(git -C "$repo" rev-parse --short "$sha")
wt=$here/.wt/$short
cache=$here/.cache/$sha
worker=$cache/renox-worker
export CARGO_TARGET_DIR=$here/.target

cleanup() {
  if [[ -d "$wt" ]]; then
    git -C "$repo" worktree remove --force "$wt" || echo "warning: could not remove the worktree $wt" >&2
  fi
}
trap cleanup EXIT

mkdir -p "$here/.wt" "$cache"
[[ ! -e "$wt" ]] || git -C "$repo" worktree remove --force "$wt"
git -C "$repo" worktree add --detach "$wt" "$sha" >&2
(cd "$wt" && bun install --frozen-lockfile >&2)

if [[ -x "$worker" ]]; then
  echo "rss-bisect: cached worker for $short, no build" >&2
else
  archive=$(find "$here/.cache/v8" -maxdepth 1 -name 'librusty_v8_*.a.gz' 2>/dev/null | head -n 1)
  if [[ -z "$archive" ]]; then
    archive=$(RENOX_CARGO_LOCK="$wt/Cargo.lock" "$repo/ops/v8-archive.sh" fetch x86_64-unknown-linux-gnu "$here/.cache/v8")
  fi
  echo "rss-bisect: building renox-worker at $short" >&2
  (cd "$wt" && RUSTY_V8_ARCHIVE=$archive CARGO_PROFILE_RELEASE_DEBUG=0 \
    cargo build --release --locked -p renox-cell --bin renox-worker >&2)
  cp "$CARGO_TARGET_DIR/release/renox-worker" "$worker.part"
  mv "$worker.part" "$worker"
fi

# HEAD's bench/ over the worktree's (it carries the BENCH_WORKER_EXTRA_TOML
# hook), without this spike's own state.
tar -C "$repo" -cf - \
  --exclude=bench/rss-bisect/.wt \
  --exclude=bench/rss-bisect/.target \
  --exclude=bench/rss-bisect/.cache \
  --exclude=bench/node_modules \
  --exclude='bench/results/raw/*' \
  bench | tar -C "$wt" -xf -

out_rel=bench/results/raw/$(date -u +%Y-%m-%d)-B1.json
(
  cd "$wt"
  B1_APPS=shop B1_SIZES=100 BENCH_RUNS=3 \
    BENCH_WORKER_EXTRA_TOML=$'[tiers.free]\ncpu_ms = 1000\n' \
    RENOX_WORKER_PATH=$worker \
    bench/run.sh B1 --profile dev-laptop >&2
)
cp "$wt/$out_rel" "$cache/B1.json"

read -r rss pss heap < <(jq -r '.summary | "\(.shop_n100_rss_delta_mb) \(.shop_n100_pss_delta_mb) \(.shop_n100_v8_heap_mb)"' "$cache/B1.json")
line="rss-bisect $sha rss_mb=$rss pss_mb=$pss v8_heap_mb=$heap"
echo "$line"
tr ' ' '\t' <<<"$line" >>"$here/steps.tsv"
