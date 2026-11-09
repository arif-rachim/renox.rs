#!/usr/bin/env bash
# Mapping breakdown of the shop isolate RSS at one commit (#457, task 5).
#
#   bench/rss-bisect/regions.sh <commit> [runs]
#
# Needs the cached worker from measure.sh (.cache/<sha>/renox-worker). Runs
# #343's regions.ts (stored under "scripts" in
# bench/results/raw/2026-11-01-B1-node-small-rss-343.json), with its harness
# import pointed at bench/scenarios/B11/harness.ts, from a worktree of
# <commit> with HEAD's bench/ copied over it and the free tier's CPU limit
# raised to 1000 ms. APP (default shop; hello has no modules), N=100.
# RUN_TS=<script> runs another script of this directory instead (trim.ts). Each run's JSON goes to
# .cache/<sha>/regions-<k>.json; the script prints the per-kind median.
#
# APP_FROM=<commit>: serve the shop app as it was at <commit> (its
# examples/shop and modules/, checked out into the throwaway worktree)
# with the first argument's worker and CLI. Separates what the worker adds from what
# the app adds. Output then goes to .cache/<sha>/regions-app-<short2>*.json.
# APP_PATHS (default "examples/shop modules") names what is taken from
# APP_FROM; "examples/shop" alone keeps the newer modules/ (needed when the
# older modules no longer pass the newer CLI's checks).
set -euo pipefail

[[ $# -ge 1 && $# -le 2 ]] || {
  echo "usage: bench/rss-bisect/regions.sh <commit> [runs]" >&2
  exit 2
}
runs=${2:-3}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse --verify "$1^{commit}")
short=$(git -C "$repo" rev-parse --short "$sha")
cache=$here/.cache/$sha
worker=$cache/renox-worker
# The same path measure.sh built from: a worker of this period loads files
# of its source tree at run time (the platform snapshot fails with ENOENT
# from any other checkout path).
wt=$here/.wt/$short
app=${APP:-shop}
tag=regions
[[ $app == shop ]] || tag=regions-$app
if [[ -n "${APP_FROM:-}" ]]; then
  app_sha=$(git -C "$repo" rev-parse --verify "$APP_FROM^{commit}")
  tag=regions-app-$(git -C "$repo" rev-parse --short "$app_sha")
  read -r -a app_paths <<<"${APP_PATHS:-examples/shop modules}"
  [[ "${APP_PATHS:-}" == "" || "$APP_PATHS" == "examples/shop modules" ]] || tag=$tag-$(tr ' /' '__' <<<"$APP_PATHS")
fi
[[ -x "$worker" ]] || {
  echo "no cached worker for $short: run measure.sh $short first" >&2
  exit 2
}

cleanup() {
  if [[ -d "$wt" ]]; then
    git -C "$repo" worktree remove --force "$wt" || echo "warning: could not remove the worktree $wt" >&2
  fi
}
trap cleanup EXIT

mkdir -p "$here/.wt"
[[ ! -e "$wt" ]] || git -C "$repo" worktree remove --force "$wt"
git -C "$repo" worktree add --detach "$wt" "$sha" >&2
(cd "$wt" && bun install --frozen-lockfile >&2)
if [[ -n "${APP_FROM:-}" ]]; then
  # Tracked files only: node_modules (workspace links) stays.
  git -C "$wt" ls-files -z "${app_paths[@]}" | (cd "$wt" && xargs -0 rm -f)
  git -C "$wt" checkout "$app_sha" -- "${app_paths[@]}"
  (cd "$wt" && bun install >&2)
fi
tar -C "$repo" -cf - \
  --exclude=bench/rss-bisect/.wt \
  --exclude=bench/rss-bisect/.target \
  --exclude=bench/rss-bisect/.cache \
  --exclude=bench/node_modules \
  --exclude='bench/results/raw/*' \
  bench | tar -C "$wt" -xf -

if [[ -n "${RUN_TS:-}" ]]; then
  # Another script of this directory with regions.ts's output shape (trim.ts).
  script=$wt/bench/rss-bisect/$RUN_TS
  [[ -f "$script" ]] || {
    echo "no script $RUN_TS in bench/rss-bisect" >&2
    exit 2
  }
  tag=$tag-${RUN_TS%.ts}
else
  script=$wt/bench/rss-bisect/regions.ts
  jq -r '.scripts["regions.ts"]' "$repo/bench/results/raw/2026-11-01-B1-node-small-rss-343.json" |
    sed "s#\"/[^\"]*/bench/scenarios/B11/harness.ts\"#\"$wt/bench/scenarios/B11/harness.ts\"#" >"$script"
  grep -q "\"$wt/bench/scenarios/B11/harness.ts\"" "$script" || {
    echo "regions.ts: harness import not rewritten" >&2
    exit 1
  }
fi

for k in $(seq 1 "$runs"); do
  (
    cd "$wt"
    APP=$app N=100 \
      BENCH_WORKER_EXTRA_TOML=$'[tiers.free]\ncpu_ms = 1000\n' \
      RENOX_WORKER_PATH=$worker \
      bun "$script" "$cache/$tag-$k.json" >/dev/null
  )
done

# Per-kind median over the runs, MB per isolate.
files=()
for k in $(seq 1 "$runs"); do files+=("$cache/$tag-$k.json"); done
jq -s --arg sha "$sha" --arg app "${app_sha:-$sha}" --arg name "$app" '
  def median: sort | if length % 2 == 1 then .[length / 2 | floor] else (.[length / 2 - 1] + .[length / 2]) / 2 end;
  . as $all
  | (map(.per_isolate_mb | keys) | add | unique) as $kinds
  | { commit: $sha, app_from: $app, app: $name, n: 100, runs: length,
      total_mb: (map(.total_mb) | median),
      threads_per_isolate: (map(.threads_per_isolate) | median),
      per_isolate_mb: (reduce $kinds[] as $k ({}; .[$k] = ([$all[] | .per_isolate_mb[$k] // 0] | median))) }
' "${files[@]}" | tee "$cache/$tag.json"
