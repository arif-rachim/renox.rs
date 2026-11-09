#!/usr/bin/env bash
# Live heap per tenant by call site at one commit (#641, task 1).
#
#   bench/rss-bisect/heaptrack.sh <commit> [app]
#
# Builds <commit>'s renox-worker with symbols for profiling (release,
# line-tables-only, not stripped, no LTO, 16 codegen units: the allocation
# sites are the same as the shipped build's, the build is faster) into
# .cache/<sha>/renox-worker-prof, in a worktree at .wt/<short> (kept: the
# worker reads bootstrap.js from it at run time) with HEAD's bench/ copied
# over it. Then it starts that worker under heaptrack (LD_PRELOAD, through a
# wrapper that execs, so the harness's PID is the worker's) with N=100
# tenants of APP (default shop), sends one request each, waits 8 s and kills
# the worker: heaptrack's "leaked" bytes are the allocations live at that
# moment. Output: .cache/<sha>/heaptrack-<app>.gz (heaptrack data) and
# .cache/<sha>/heaptrack-<app>.sites (one line per call site, see
# heaptrack-sites.py). Compare two commits with
#
#   python3 bench/rss-bisect/heaptrack-sites.py diff <a.sites> <b.sites> 100
#
# Needs heaptrack (apt install heaptrack) and rustfilt (cargo install rustfilt).
set -euo pipefail

[[ $# -ge 1 && $# -le 2 ]] || {
  echo "usage: bench/rss-bisect/heaptrack.sh <commit> [app]" >&2
  exit 2
}
app=${2:-shop}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse --verify "$1^{commit}")
short=$(git -C "$repo" rev-parse --short "$sha")
cache=$here/.cache/$sha
worker=$cache/renox-worker-prof
wt=$here/.wt/$short
for tool in heaptrack heaptrack_print rustfilt; do
  command -v "$tool" >/dev/null || {
    echo "$tool is required" >&2
    exit 2
  }
done

mkdir -p "$cache" "$here/.wt" "$here/.cache/v8"
[[ -e "$wt" ]] || git -C "$repo" worktree add --detach "$wt" "$sha" >&2
(cd "$wt" && bun install --frozen-lockfile >&2)
if [[ ! -x "$worker" ]]; then
  archive=$(find "$here/.cache/v8" -maxdepth 1 -name 'librusty_v8_*.a.gz' 2>/dev/null | head -n 1)
  if [[ -z "$archive" ]]; then
    archive=$(RENOX_CARGO_LOCK="$wt/Cargo.lock" "$repo/ops/v8-archive.sh" fetch x86_64-unknown-linux-gnu "$here/.cache/v8")
  fi
  (cd "$wt" && CARGO_TARGET_DIR=$here/.target-prof RUSTY_V8_ARCHIVE=$archive \
    CARGO_PROFILE_RELEASE_DEBUG=line-tables-only CARGO_PROFILE_RELEASE_STRIP=false \
    CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    cargo build --release --locked -p renox-cell --bin renox-worker >&2)
  cp "$here/.target-prof/release/renox-worker" "$worker"
fi

tar -C "$repo" -cf - \
  --exclude=bench/rss-bisect/.wt \
  --exclude=bench/rss-bisect/.target \
  --exclude=bench/rss-bisect/.target-prof \
  --exclude=bench/rss-bisect/.cache \
  --exclude=bench/node_modules \
  --exclude='bench/results/raw/*' \
  bench | tar -C "$wt" -xf -

# The wrapper the harness starts as the worker: heaptrack's own script would
# keep a shell between the harness and the worker.
lib=$(dirname "$(readlink -f "$(command -v heaptrack)")")/../lib/heaptrack
wrap=$cache/heaptrack-wrap.sh
cat >"$wrap" <<EOF
#!/usr/bin/env bash
pipe=\$(mktemp -u /tmp/heaptrack-fifo.XXXXXX); mkfifo "\$pipe"
"$lib/libexec/heaptrack_interpret" < "\$pipe" | gzip -c > "$cache/heaptrack-$app.gz" &
exec env LD_PRELOAD="$lib/libheaptrack_preload.so" DUMP_HEAPTRACK_OUTPUT="\$pipe" "$worker" "\$@"
EOF
chmod +x "$wrap"

(
  cd "$wt"
  APP=$app N=100 \
    BENCH_WORKER_EXTRA_TOML=$'[tiers.free]\ncpu_ms = 1000\n' \
    RENOX_WORKER_PATH=$wrap \
    bun "$wt/bench/rss-bisect/heaptrack-run.ts" >&2
)
sleep 5
heaptrack_print -f "$cache/heaptrack-$app.gz" --print-leaks 0 --print-peaks 0 \
  --print-allocators 0 --print-temporary 0 --flamegraph-cost-type leaked -F /dev/stdout 2>/dev/null |
  grep ';' | rustfilt | python3 "$here/heaptrack-sites.py" compact >"$cache/heaptrack-$app.sites"
python3 "$here/heaptrack-sites.py" top "$cache/heaptrack-$app.sites" 100
