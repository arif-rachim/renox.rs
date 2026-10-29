#!/usr/bin/env bash
# Tests of fetch-litestream.sh (#252), run by CI: a tarball whose SHA-256
# matches ops/litestream.lock is installed; one changed byte is refused
# before extraction and leaves nothing behind; an unknown target is refused.
# Uses a file:// mirror and a temporary lock file, so no network is needed.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fetch=$here/fetch-litestream.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

version=9.9.9
tarball=litestream-v$version-linux-amd64.tar.gz
mkdir -p "$tmp/src" "$tmp/mirror/v$version"
printf '#!/bin/sh\necho "litestream v%s"\n' "$version" > "$tmp/src/litestream"
tar -czf "$tmp/mirror/v$version/$tarball" -C "$tmp/src" litestream
sum=$(sha256sum "$tmp/mirror/v$version/$tarball" | awk '{ print $1 }')

lock() { printf 'version %s\nx86_64-unknown-linux-gnu  %s  %s\n' "$version" "$1" "$tarball" > "$tmp/lock"; }
run() { RENOX_LITESTREAM_LOCK=$tmp/lock RENOX_LITESTREAM_MIRROR=file://$tmp/mirror "$fetch" "$@"; }

# 1. A matching tarball is installed and its path printed.
lock "$sum"
if out=$(run x86_64-unknown-linux-gnu "$tmp/ok" 2>"$tmp/err") && [[ $out == "$tmp/ok/litestream" && -x $tmp/ok/litestream ]]; then
  pass "a tarball matching the lock is installed"
else
  fail "a tarball matching the lock is installed: $(cat "$tmp/err")"
fi

# 2. One changed byte in the tarball: refused, nothing extracted.
cp "$tmp/mirror/v$version/$tarball" "$tmp/good.tar.gz"
printf 'x' >> "$tmp/mirror/v$version/$tarball"
if run x86_64-unknown-linux-gnu "$tmp/bad" 2>"$tmp/err"; then
  fail "a changed tarball is refused"
elif grep -q "checksum mismatch" "$tmp/err" && [[ ! -e $tmp/bad/litestream ]] && [[ -z $(find "$tmp/bad" -mindepth 1 -print -quit) ]]; then
  pass "a changed tarball is refused before extraction (checksum mismatch, nothing left)"
else
  fail "a changed tarball is refused: $(cat "$tmp/err")"
fi
cp "$tmp/good.tar.gz" "$tmp/mirror/v$version/$tarball"

# 3. A lock whose hash differs from the published tarball: refused.
lock "$(printf '0%.0s' {1..64})"
if run x86_64-unknown-linux-gnu "$tmp/wrong" 2>"$tmp/err"; then
  fail "a lock with another hash refuses the download"
elif grep -q "checksum mismatch" "$tmp/err"; then
  pass "a lock with another hash refuses the download"
else
  fail "a lock with another hash refuses the download: $(cat "$tmp/err")"
fi

# 4. A target without an entry: refused.
lock "$sum"
if run aarch64-apple-darwin "$tmp/none" 2>"$tmp/err"; then
  fail "a target without an entry is refused"
elif grep -q "no entry for target" "$tmp/err"; then
  pass "a target without an entry is refused"
else
  fail "a target without an entry is refused: $(cat "$tmp/err")"
fi

# 5. The real lock has a well-formed entry for both Linux targets.
for t in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
  if awk -v t="$t" '$1 == t && $2 ~ /^[0-9a-f]{64}$/ { found = 1 } END { exit !found }' "$here/../litestream.lock"; then
    pass "ops/litestream.lock pins $t"
  else
    fail "ops/litestream.lock pins $t"
  fi
done

if [[ $failures -ne 0 ]]; then
  echo "$failures failed" >&2
  exit 1
fi
echo "all passed"
