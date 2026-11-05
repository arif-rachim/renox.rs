#!/usr/bin/env bash
# Step 3 of ops/single-host.md (#400): `bun install --frozen-lockfile
# --production` in a checkout of the tracked files, as on the host's
# /opt/renox/src. The host runs only control/api, which does not import the
# SDK; the SDK's build needs the dev toolchain (tsc, bun-types, the kysely and
# drizzle types), so its `prepare` builds sdk/dist only when the repository's
# own compiler is installed and otherwise says it skipped. PATH is reduced to
# the directory of bun and the base system, so a tsc installed elsewhere on
# the machine plays no part. A dev install of the same files (CI, the deploy
# checkout of ops/single-host.md, `npm publish`) still builds sdk/dist.
#
#   ops/scripts/production-install.test.sh [<dir to keep the installed tree in>]
#
# With a directory, the production tree is left there (bootstrap-node.test.sh
# runs renox-control.service from it). Needs bun (RENOX_BUN_BIN, default
# `bun` on PATH) and the npm registry; skipped without bun.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo=$(cd "$here/.." && pwd)
bun_bin=${RENOX_BUN_BIN:-$(command -v bun || true)}
[[ -n $bun_bin && -x $bun_bin ]] || { echo "SKIP production-install test: no bun (RENOX_BUN_BIN)"; exit 0; }
bun_bin=$(realpath "$bun_bin")

keep=${1:-}
if [[ -n $keep ]]; then
  mkdir -p "$keep"
  [[ -z $(ls -A "$keep") ]] || { echo "production-install: $keep is not empty" >&2; exit 2; }
  out=$keep
  trap - EXIT
else
  out=$(mktemp -d)
  trap 'rm -rf "$out"' EXIT
fi

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

# The tracked files only: no node_modules, no sdk/dist, nothing a dev install left behind.
(cd "$repo" && git ls-files -z | tar --null -T - -cf -) | tar -xf - -C "$out"

clean_path=$(dirname "$bun_bin"):/usr/sbin:/usr/bin:/sbin:/bin
if (cd "$out" && env -i HOME="$out/.home" PATH="$clean_path" ${HTTPS_PROXY:+HTTPS_PROXY=$HTTPS_PROXY} \
  ${SSL_CERT_FILE:+SSL_CERT_FILE=$SSL_CERT_FILE} ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS} \
  "$bun_bin" install --frozen-lockfile --production) >"$out/.install.log" 2>&1; then
  pass "bun install --frozen-lockfile --production succeeds on the tracked files"
else
  fail "bun install --frozen-lockfile --production: $(tail -n 15 "$out/.install.log")"
fi
if [[ ! -e $out/sdk/dist ]]; then
  pass "the SDK's prepare skips its build in a production install (no sdk/dist, no error)"
else fail "the SDK's prepare in a production install built sdk/dist without the dev toolchain?"; fi
# The control API starts from the production tree on Postgres (#400): PGlite
# is a dev dependency, loaded only for a pglite: URL, so the production tree
# has none and the API's whole import graph still loads. Started against a
# port nothing listens on, it gets as far as connecting to the database and
# fails there, not on a missing module.
if [[ ! -d $out/node_modules/@electric-sql/pglite ]]; then
  pass "@electric-sql/pglite (a dev dependency) is not installed by --production"
else fail "@electric-sql/pglite is installed by --production: it is a dev dependency"; fi
start_log=$out/.start.log
(cd "$out/control/api" && env -i HOME="$out/.home" PATH="$clean_path" CONTROL_DATABASE_URL=postgres://renox@127.0.0.1:1/none \
  CONTROL_LISTEN_PORT=18911 CONTROL_NODE_LISTEN_PORT=18912 timeout 60 "$bun_bin" src/main.ts) >"$start_log" 2>&1 || true
if grep -q "ERR_POSTGRES_CONNECTION_REFUSED" "$start_log" && ! grep -qiE "cannot find (module|package)" "$start_log"; then
  pass "control/api starts from the production tree: every module loads and it stops at the Postgres connection"
else fail "control/api from the production tree: $(tail -n 10 "$start_log")"; fi
if [[ ! -e $out/node_modules/typescript ]]; then pass "the dev toolchain (typescript) is not installed"; else fail "typescript is installed by --production"; fi
rm -rf "$out/.home" "$start_log"

# A dev install of the same files still builds sdk/dist (what CI and the
# deploy checkout rely on: control/dashboard and www import renox from it).
dev=$(mktemp -d)
(cd "$repo" && git ls-files -z | tar --null -T - -cf -) | tar -xf - -C "$dev"
if (cd "$dev" && env -i HOME="$dev/.home" PATH="$clean_path" ${HTTPS_PROXY:+HTTPS_PROXY=$HTTPS_PROXY} \
  ${SSL_CERT_FILE:+SSL_CERT_FILE=$SSL_CERT_FILE} ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS} \
  "$bun_bin" install --frozen-lockfile) >"$dev/.install.log" 2>&1 \
  && [[ -s $dev/sdk/dist/index.js && -s $dev/sdk/dist/index.d.ts && -s $dev/sdk/dist/test.js ]]; then
  pass "a dev install (bun install --frozen-lockfile) builds sdk/dist through prepare"
else fail "a dev install builds sdk/dist: $(tail -n 10 "$dev/.install.log")"; fi
rm -rf "$dev"

if [[ $failures -ne 0 ]]; then echo "$failures failed" >&2; exit 1; fi
echo "all passed"
