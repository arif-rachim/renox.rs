#!/usr/bin/env bash
# F0 spike smoke test (issue #3): start the runtime, wait for readiness, check
# that GET / is answered by examples/hello with {"ok":true}, stop the runtime.
# Prints startup time (process start to ready) in ms.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
port=${PORT:-9000}

"$here/run.sh" --build-only >/dev/null
trap '"$here/run.sh" --stop' EXIT

t0=$(date +%s%N)
"$here/run.sh" --background --port "$port" >/dev/null
t1=$(date +%s%N)
echo "startup_ms=$(((t1 - t0) / 1000000))"

body=$(curl -fsS "http://127.0.0.1:$port/")
if [[ $body != '{"ok":true}' ]]; then
  echo "FAIL: GET / returned '$body', expected '{\"ok\":true}'" >&2
  exit 1
fi
echo "PASS: GET / -> $body"
