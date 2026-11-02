#!/usr/bin/env bash
# Tests of fetch-cloudflared.sh (#366), run by CI's ops step: a binary whose
# SHA-256 matches the lock is installed; one changed byte is refused and
# leaves nothing behind; a lock with another hash and an unknown target are
# refused. Uses a file:// mirror and a temporary lock file: no network.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fetch=$here/fetch-cloudflared.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

version=2099.1.0
asset=cloudflared-linux-amd64
mkdir -p "$tmp/mirror/$version"
printf '#!/bin/sh\necho "cloudflared version %s"\n' "$version" > "$tmp/mirror/$version/$asset"
sum=$(sha256sum "$tmp/mirror/$version/$asset" | awk '{ print $1 }')

lock() { printf 'version %s\nx86_64-unknown-linux-gnu  %s  %s\n' "$version" "$1" "${2:-$asset}" > "$tmp/lock"; }
run() { RENOX_CLOUDFLARED_LOCK=$tmp/lock RENOX_CLOUDFLARED_MIRROR=file://$tmp/mirror "$fetch" "$@"; }
empty() { [[ ! -e $1 ]] || [[ -z $(find "$1" -mindepth 1 -print -quit) ]]; }

# 1. A matching binary is installed, executable, and its path printed.
lock "$sum"
if out=$(run x86_64-unknown-linux-gnu "$tmp/ok" 2>"$tmp/err") && [[ $out == "$tmp/ok/cloudflared" && -x $tmp/ok/cloudflared ]]; then
  pass "a binary matching the lock is installed"
else
  fail "a binary matching the lock is installed: $(cat "$tmp/err")"
fi

# 2. One changed byte: refused, nothing installed.
cp "$tmp/mirror/$version/$asset" "$tmp/good"
printf 'x' >> "$tmp/mirror/$version/$asset"
if run x86_64-unknown-linux-gnu "$tmp/bad" 2>"$tmp/err"; then
  fail "a changed binary is refused"
elif grep -q "checksum mismatch" "$tmp/err" && empty "$tmp/bad"; then
  pass "a changed binary is refused (checksum mismatch, nothing left)"
else
  fail "a changed binary is refused: $(cat "$tmp/err")"
fi
cp "$tmp/good" "$tmp/mirror/$version/$asset"

# 3. A lock whose hash differs from the published binary: refused.
lock "$(printf '0%.0s' {1..64})"
if run x86_64-unknown-linux-gnu "$tmp/wrong" 2>"$tmp/err"; then
  fail "a lock with another hash refuses the download"
elif grep -q "checksum mismatch" "$tmp/err" && empty "$tmp/wrong"; then
  pass "a lock with another hash refuses the download"
else
  fail "a lock with another hash refuses the download: $(cat "$tmp/err")"
fi

# 4. A target without an entry, and an asset name that is not cloudflared-linux-<arch>: refused.
lock "$sum"
if run aarch64-apple-darwin "$tmp/none" 2>"$tmp/err"; then
  fail "a target without an entry is refused"
elif grep -q "no entry for target" "$tmp/err"; then
  pass "a target without an entry is refused"
else
  fail "a target without an entry is refused: $(cat "$tmp/err")"
fi
lock "$sum" "../../etc/passwd"
if run x86_64-unknown-linux-gnu "$tmp/path" 2>"$tmp/err"; then
  fail "an asset name with a path is refused"
else
  pass "an asset name with a path is refused"
fi

# 5. The real lock pins both Linux targets.
for t in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
  if awk -v t="$t" '$1 == t && $2 ~ /^[0-9a-f]{64}$/ && $3 ~ /^cloudflared-linux-/ { found = 1 } END { exit !found }' "$here/../cloudflared.lock"; then
    pass "ops/cloudflared.lock pins $t"
  else
    fail "ops/cloudflared.lock pins $t"
  fi
done

if [[ $failures -ne 0 ]]; then
  echo "$failures failed" >&2
  exit 1
fi
echo "all passed"
