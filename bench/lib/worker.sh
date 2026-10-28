#!/usr/bin/env bash
# Drives renox-worker (crates/renox-cell) for the F1 benchmarks (#35).
#
#   bench/lib/worker.sh build
#       Builds the release worker (cargo build --release -p renox-cell) and
#       prints its path. RENOX_WORKER_PATH skips the build and is printed.
#   bench/lib/worker.sh setup <dir> <port> <idle_timeout_s> <tenants-file>
#       Builds the artifact of every app named in <tenants-file> with the CLI
#       (examples/<app> -> <dir>/artifacts/<hash>/) and writes
#       <dir>/worker.toml and <dir>/routes.json. Each line of <tenants-file>:
#       "<hostname> <tenant_id> <app>"; <app> is a name under examples/ or
#       the absolute path of an app directory (B8 stages one).
#   bench/lib/worker.sh start <dir>
#       Starts the worker in the background (log: <dir>/worker.log), waits
#       until it listens, and prints its pid (also in <dir>/worker.pid).
#   bench/lib/worker.sh stop <dir>
#       Stops it (SIGINT, then SIGKILL after 5 s).
set -euo pipefail

bench_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd "$bench_dir/.." && pwd)

die() {
  echo "worker.sh: $*" >&2
  exit 1
}

cmd_build() {
  if [[ -n "${RENOX_WORKER_PATH:-}" ]]; then
    [[ -x "$RENOX_WORKER_PATH" ]] || die "RENOX_WORKER_PATH=$RENOX_WORKER_PATH is not executable"
    echo "$RENOX_WORKER_PATH"
    return
  fi
  command -v cargo >/dev/null 2>&1 || die "cargo is required (https://rustup.rs), or set RENOX_WORKER_PATH"
  (cd "$repo_dir" && cargo build --release -p renox-cell --bin renox-worker >&2)
  echo "$repo_dir/target/release/renox-worker"
}

cmd_setup() {
  [[ $# -eq 4 ]] || die "usage: setup <dir> <port> <idle_timeout_s> <tenants-file>"
  local dir=$1 port=$2 idle=$3 tenants=$4
  command -v bun >/dev/null 2>&1 || die "bun is required (https://bun.sh)"
  [[ -f "$tenants" ]] || die "no tenants file $tenants"
  mkdir -p "$dir/artifacts" "$dir/data" "$dir/meters" "$dir/logs"
  local -A hashes=()
  local host tenant app app_dir hash
  while read -r host tenant app; do
    [[ -n "${host:-}" ]] || continue
    if [[ -z "${hashes[$app]:-}" ]]; then
      if [[ $app == /* ]]; then app_dir=$app; else app_dir=$repo_dir/examples/$app; fi
      [[ -f "$app_dir/renox.toml" ]] || die "unknown app $app"
      hash=$(cd "$app_dir" && bun "$repo_dir/cli/src/main.ts" build --out "$dir/artifacts" | awk '/^artifact /{print $2}')
      [[ ${#hash} -eq 64 ]] || die "building $app_dir failed"
      hashes[$app]=$hash
      echo "$app $hash" >>"$dir/apps.txt"
    fi
  done <"$tenants"
  local now
  now=$(($(date +%s) * 1000))
  {
    echo '{ "version": 0, "entries": ['
    local first=1
    while read -r host tenant app; do
      [[ -n "${host:-}" ]] || continue
      [[ $first -eq 1 ]] || echo ','
      first=0
      printf '{"hostname":"%s","tenant_id":"%s","deployment_hash":"%s","status":"active","updated_at":%s}' \
        "$host" "$tenant" "${hashes[$app]}" "$now"
    done <"$tenants"
    echo ']}'
  } >"$dir/routes.json"
  cat >"$dir/worker.toml" <<TOML
listen = "127.0.0.1:$port"
data_dir = "data"
artifacts_dir = "artifacts"
routes_file = "routes.json"
meters_dir = "meters"
logs_dir = "logs"
node_id = "bench"
idle_timeout_secs = $idle
meter_flush_ms = 500

# All benchmark load comes from 127.0.0.1: lift the per-client limits.
[gateway]
rate_limit_per_ip = 10000000.0
rate_limit_burst = 10000000
max_connections_per_ip = 100000
TOML
}

cmd_start() {
  [[ $# -eq 1 ]] || die "usage: start <dir>"
  local dir=$1 bin port pid
  bin=$(cmd_build)
  port=$(awk -F'[:"]' '/^listen/ {print $(NF-1)}' "$dir/worker.toml")
  RUST_LOG=${RUST_LOG:-warn} "$bin" --config "$dir/worker.toml" >"$dir/worker.log" 2>&1 &
  pid=$!
  echo "$pid" >"$dir/worker.pid"
  for _ in $(seq 1 600); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "$pid"
      return
    fi
    kill -0 "$pid" 2>/dev/null || die "renox-worker exited; see $dir/worker.log"
    sleep 0.1
  done
  die "renox-worker did not listen on $port within 60 s"
}

cmd_stop() {
  [[ $# -eq 1 ]] || die "usage: stop <dir>"
  local dir=$1 pid
  [[ -f "$dir/worker.pid" ]] || return 0
  pid=$(cat "$dir/worker.pid")
  kill -INT "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$dir/worker.pid"
}

[[ $# -ge 1 ]] || die "usage: worker.sh build|setup|start|stop ..."
sub=$1
shift
case "$sub" in
  build) cmd_build "$@" ;;
  setup) cmd_setup "$@" ;;
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  *) die "unknown command $sub" ;;
esac
