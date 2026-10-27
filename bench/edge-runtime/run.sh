#!/usr/bin/env bash
# F0 spike (issue #3): obtain, build, and start the pinned Supabase Edge
# Runtime with bench/edge-runtime/main as the main service, routing requests
# to staged copies of the example apps.
#
# usage: run.sh [--mode source|docker] [--build-only] [--stage]
#               [--background] [--stop] [--status] [--port N]
#               [--policy per_worker|per_request|oneshot] [-- extra start args]
#
#   --mode source  clone and build upstream at the pinned tag (default)
#   --mode docker  use the pinned upstream image instead of a local build
#                  (public.ecr.aws/supabase/edge-runtime:<tag>); no Rust needed
#   --build-only   obtain the runtime (build or pull), then exit
#   --stage        copy examples/* into the staging directory, install their
#                  npm dependencies there, then exit (also done on every start)
#   --background   start detached, wait for readiness, print "<pid> <mode>"
#   --stop         stop a runtime started with --background
#   --status       print the host PID of a running runtime (exit 1 if none)
#   --port N       listen port (default 9000)
#   --policy P     worker pool policy (default per_worker; oneshot evicts the
#                  user worker after every request, used by B4)
#
# Environment: EDGE_RUNTIME_MODE (same as --mode), EDGE_RUNTIME_HOME (default
# ~/.cache/renox/edge-runtime/<tag>), EDGE_RUNTIME_REBUILD=1 forces a rebuild.
#
# The upstream checkout, its build, and the staged apps live outside the
# repository, in $EDGE_RUNTIME_HOME: bench/spike/* is a Cargo workspace glob,
# an in-tree Deno checkout would be picked up by the bench TypeScript check and
# by `bun test`, and (see NOTES.md, "The root package.json trap") an app served
# from inside this monorepo makes Deno load the root workspace into every
# user worker, which multiplies worker memory and start time by five.
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
apps="$home/apps"
pid_file="$home/edge-runtime.pid"
log_file="$home/edge-runtime.log"
image="public.ecr.aws/supabase/edge-runtime:$tag"
container="renox-edge-runtime"

mode=${EDGE_RUNTIME_MODE:-source}
action=foreground
port=9000
policy=per_worker
extra=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --mode) mode=${2:?--mode needs a value}; shift ;;
    --build-only) action=build ;;
    --stage) action=stage ;;
    --background) action=background ;;
    --stop) action=stop ;;
    --status) action=status ;;
    --port) port=${2:?--port needs a value}; shift ;;
    --policy) policy=${2:?--policy needs a value}; shift ;;
    --) shift; extra=("$@"); break ;;
    *) echo "error: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done
case $mode in
  source | docker) ;;
  *) echo "error: --mode must be source or docker, got '$mode'" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------- stop/status
stop() {
  if [[ -f $pid_file ]]; then
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
  fi
  if command -v docker >/dev/null 2>&1; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
}

status() {
  local found
  if [[ -f $pid_file ]]; then
    found=$(<"$pid_file")
    if kill -0 "$found" 2>/dev/null; then
      echo "$found"
      return 0
    fi
  fi
  if command -v docker >/dev/null 2>&1; then
    found=$(docker inspect --format '{{.State.Pid}}' "$container" 2>/dev/null || true)
    if [[ -n $found && $found != 0 ]]; then
      echo "$found"
      return 0
    fi
  fi
  return 1
}

if [[ $action == stop ]]; then
  stop
  exit 0
fi
if [[ $action == status ]]; then
  status
  exit $?
fi

mkdir -p "$home"

# --------------------------------------------------------------------- stage
# Copies every example app that has a _spike entry to $apps/<app>, without the
# repository's package.json above it, and installs the app's own npm
# dependencies there so Deno can resolve bare specifiers from node_modules.
stage() {
  local app src_dir dst_dir
  mkdir -p "$apps"
  for src_dir in "$repo_dir"/examples/*/; do
    app=$(basename "$src_dir")
    [[ -d $src_dir/_spike ]] || continue
    dst_dir="$apps/$app"
    rm -rf "$dst_dir"
    mkdir -p "$dst_dir"
    # Not node_modules, not the lockfiles of the monorepo.
    (cd "$src_dir" && tar --exclude=node_modules --exclude='*.lock' --exclude='*.lockb' -cf - .) | tar -xf - -C "$dst_dir"
    if [[ -f $dst_dir/package.json ]] && grep -q '"dependencies"' "$dst_dir/package.json"; then
      if command -v bun >/dev/null 2>&1; then
        (cd "$dst_dir" && bun install --silent --no-summary >/dev/null)
      elif command -v npm >/dev/null 2>&1; then
        (cd "$dst_dir" && npm install --no-audit --no-fund --loglevel=error >/dev/null)
      else
        echo "error: bun or npm is needed to install $app's dependencies" >&2
        exit 1
      fi
    fi
  done
  echo "$apps"
}

if [[ $action == stage ]]; then
  stage
  exit 0
fi

# ------------------------------------------------------------------- obtain
if [[ $mode == source ]]; then
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
  if [[ $action == build ]]; then
    echo "$bin"
    exit 0
  fi
else
  command -v docker >/dev/null 2>&1 || { echo "error: --mode docker needs docker" >&2; exit 1; }
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "pulling $image" >&2
    docker pull --quiet "$image" >&2
  fi
  if [[ $action == build ]]; then
    echo "$image"
    exit 0
  fi
fi

# -------------------------------------------------------------------- start
stage >/dev/null
stop

if [[ $mode == source ]]; then
  args=("$bin" start --main-service "$here/main" --port "$port" --policy "$policy" "${extra[@]}")
  export RENOX_APPS_DIR=$apps
  if [[ $action == foreground ]]; then
    exec "${args[@]}"
  fi
  cd "$repo_dir"
  nohup "${args[@]}" >"$log_file" 2>&1 &
  pid=$!
  echo "$pid" >"$pid_file"
else
  # The main service and the staged apps are mounted read-only; the container
  # sees neither the repository nor the host environment. The host PID of the
  # runtime process comes from docker inspect, so /proc/<pid> works as usual.
  dargs=(--name "$container" -p "127.0.0.1:$port:9000"
    -e RENOX_APPS_DIR=/apps -v "$apps:/apps:ro" -v "$here/main:/main:ro"
    "$image" start --main-service /main --port 9000 --policy "$policy" "${extra[@]}")
  if [[ $action == foreground ]]; then
    exec docker run --rm "${dargs[@]}"
  fi
  docker run -d "${dargs[@]}" >/dev/null
  pid=$(docker inspect --format '{{.State.Pid}}' "$container")
fi

for _ in $(seq 1 600); do
  if curl -fsS "http://127.0.0.1:$port/_renox/health" >/dev/null 2>&1; then
    echo "$pid $mode"
    exit 0
  fi
  if ! status >/dev/null; then
    echo "error: edge-runtime exited during startup" >&2
    if [[ $mode == source ]]; then tail -n 40 "$log_file" >&2; else docker logs "$container" 2>&1 | tail -n 40 >&2; fi
    stop
    exit 1
  fi
  sleep 0.1
done
echo "error: edge-runtime not ready after 60 s" >&2
stop
exit 1
