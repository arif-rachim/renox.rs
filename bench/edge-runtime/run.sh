#!/usr/bin/env bash
# F0 spike (issue #3): obtain, build, and start the pinned Supabase Edge
# Runtime with bench/edge-runtime/main as the main service, routing to
# examples/hello by default.
#
# usage: run.sh [--build-only] [--background] [--stop] [--port N]
#               [--policy per_worker|per_request|oneshot] [-- extra start args]
#
#   --build-only   clone and build, then exit (prints the binary path)
#   --background   start detached, wait for readiness, print the PID, exit 0
#   --stop         stop a runtime started with --background
#   --port N       listen port (default 9000)
#   --policy P     worker pool policy (default per_worker; oneshot evicts the
#                  user worker after every request, used by B4)
#
# The upstream checkout and its build live outside the repository, in
# $EDGE_RUNTIME_HOME (default ~/.cache/renox/edge-runtime/<tag>): bench/spike/*
# is a Cargo workspace glob, and an in-tree Deno checkout would be picked up by
# the bench TypeScript check and by `bun test`.
#
# V8 is never built from source: V8_FROM_SOURCE is unset and the prebuilt
# rusty_v8 static library is downloaded from RUSTY_V8_MIRROR, which upstream's
# .cargo/config.toml sets to Supabase's rusty_v8 fork releases.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd "$here/../.." && pwd)
read -r tag commit <"$here/VERSION"

home=${EDGE_RUNTIME_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/renox/edge-runtime/$tag}
src="$home/src"
bin="$src/target/release/edge-runtime"
pid_file="$home/edge-runtime.pid"
log_file="$home/edge-runtime.log"

mode=foreground
port=9000
policy=per_worker
extra=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --build-only) mode=build ;;
    --background) mode=background ;;
    --stop) mode=stop ;;
    --port) port=${2:?--port needs a value}; shift ;;
    --policy) policy=${2:?--policy needs a value}; shift ;;
    --) shift; extra=("$@"); break ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

stop() {
  [[ -f $pid_file ]] || return 0
  local pid
  pid=$(<"$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in $(seq 1 100); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

if [[ $mode == stop ]]; then
  stop
  exit 0
fi

mkdir -p "$home"

# 1. Obtain the pinned version.
if [[ ! -d $src/.git ]]; then
  echo "cloning supabase/edge-runtime $tag into $src" >&2
  git clone --quiet --depth 1 --branch "$tag" https://github.com/supabase/edge-runtime "$src"
fi
actual=$(git -C "$src" rev-parse HEAD)
if [[ $actual != "$commit" ]]; then
  echo "error: $src is at $actual, VERSION pins $tag = $commit" >&2
  exit 1
fi

# 2. Build (release, prebuilt V8). Upstream's rust-toolchain.toml selects its
# own Rust version; rustup installs it on first use.
if [[ ! -x $bin || ${EDGE_RUNTIME_REBUILD:-0} == 1 ]]; then
  echo "building edge-runtime (cargo build --release) in $src" >&2
  start=$(date +%s)
  (cd "$src" && env -u V8_FROM_SOURCE cargo build --release --locked --bin edge-runtime)
  echo "build finished in $(($(date +%s) - start)) s" >&2
fi

if [[ $mode == build ]]; then
  echo "$bin"
  exit 0
fi

# 3. Start. The main service gets the repository root so it can resolve
# examples/<app>/_spike as user worker service paths.
args=(start --main-service "$here/main" --port "$port" --policy "$policy" "${extra[@]}")
export RENOX_REPO_DIR=$repo_dir

if [[ $mode == foreground ]]; then
  exec "$bin" "${args[@]}"
fi

stop
# Run from the repository root so relative paths in logs are short.
cd "$repo_dir"
nohup "$bin" "${args[@]}" >"$log_file" 2>&1 &
pid=$!
echo "$pid" >"$pid_file"
for _ in $(seq 1 300); do
  if curl -fsS "http://127.0.0.1:$port/_renox/health" >/dev/null 2>&1; then
    echo "$pid"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "error: edge-runtime exited during startup; log: $log_file" >&2
    tail -n 40 "$log_file" >&2
    rm -f "$pid_file"
    exit 1
  fi
  sleep 0.1
done
echo "error: edge-runtime not ready after 30 s; log: $log_file" >&2
stop
exit 1
