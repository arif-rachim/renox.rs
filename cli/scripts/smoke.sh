#!/usr/bin/env bash
# Smoke test of a compiled `renox` from a directory outside the repository
# (#448): the steps a new developer takes in the first hour.
#
#   cli/scripts/smoke.sh <renox binary> [<@renoxium/sdk tarball>]
#
# The worker is the pinned renox-worker installed beside the binary (as
# install.sh does), or RENOX_WORKER_PATH. With a tarball the app installs
# that SDK instead of the npm release (a release that is not published yet).
# Needs bun, curl and ps on PATH. Exits non-zero at the first failed step.
set -euo pipefail

# An absolute path without realpath(1): macOS before 13 has none (#462).
abspath() { (cd "$(dirname "$1")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$1")"); }
RENOX=$(abspath "$1")
SDK=${2:+$(abspath "$2")}
PORT=${SMOKE_PORT:-18787}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/renox-smoke-XXXXXX")
DEV_PID=""
cleanup() {
  if [[ -n "$DEV_PID" ]]; then kill -INT "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }

cd "$WORK"
step "renox --version"
"$RENOX" --version

step "renox new demo --template hello"
"$RENOX" new demo --template hello
cd demo
test -f README.md && test -f pages/index.html && test -f tests/hello.test.ts

if [[ -n "$SDK" ]]; then
  step "use the SDK tarball $SDK"
  SDK="$SDK" bun -e 'const f = "package.json"; const p = await Bun.file(f).json(); p.dependencies["@renoxium/sdk"] = `file:${process.env.SDK}`; await Bun.write(f, JSON.stringify(p, null, 2) + "\n");'
fi

step "bun install"
bun install

step "renox check"
"$RENOX" check

step "renox build"
"$RENOX" build

step "renox test (and never more than one renox process)"
"$RENOX" test &
TEST_PID=$!
MAX=0
while kill -0 "$TEST_PID" 2>/dev/null; do
  # macOS prints the full path in comm; keep the base name.
  N=$(ps -eo comm= | sed 's|.*/||' | grep -cx renox || true)
  (( N > MAX )) && MAX=$N
  # 2: the parent, plus a fork of it for an instant before it execs `bun`.
  if (( N > 2 )); then echo "renox test spawned $N renox processes" >&2; kill -9 "$TEST_PID"; exit 1; fi
  sleep 0.2
done
wait "$TEST_PID"
echo "renox processes at most: $MAX"

step "renox add auth --yes"
"$RENOX" add auth --yes
grep -q '^auth = ' renox.toml
test -f renox.lock

step "renox dev, then GET /api/hello and GET /"
"$RENOX" dev --port "$PORT" > "$WORK/dev.log" 2>&1 &
DEV_PID=$!
for _ in $(seq 1 150); do
  if curl -fsS "http://localhost:$PORT/api/hello" > "$WORK/hello.json" 2>/dev/null; then break; fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then cat "$WORK/dev.log" >&2; exit 1; fi
  sleep 0.2
done
cat "$WORK/hello.json"; echo
grep -q '"ok":true' "$WORK/hello.json"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -H 'accept: text/html' "http://localhost:$PORT/")
echo "GET / -> $STATUS"
[[ "$STATUS" == 200 ]]
echo "--- renox dev output"
cat "$WORK/dev.log"
if grep -Eq 'fetch_blocked_addresses|platform_key_file|watermark|disk usage unreadable' "$WORK/dev.log"; then echo "renox dev printed a production-only warning" >&2; exit 1; fi

printf '\nsmoke test passed\n'
