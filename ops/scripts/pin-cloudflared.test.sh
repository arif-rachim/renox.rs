#!/usr/bin/env bash
# Tests of pin-cloudflared.sh (#547), with a file:// mirror and a copy of the
# lock: no network. Proves: matching downloads rewrite the version, every
# target's digest and the header date, and fetch-cloudflared.sh then accepts
# the new pin; two downloads that differ, a missing asset and a malformed
# version leave the lock unchanged.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pin=$here/pin-cloudflared.sh
fetch=$here/fetch-cloudflared.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

version=2099.2.3
mkdir -p "$tmp/mirror/$version"
for arch in amd64 arm64; do
  printf '#!/bin/sh\necho "cloudflared %s %s"\n' "$version" "$arch" > "$tmp/mirror/$version/cloudflared-linux-$arch"
done
amd=$(sha256sum "$tmp/mirror/$version/cloudflared-linux-amd64" | awk '{ print $1 }')
arm=$(sha256sum "$tmp/mirror/$version/cloudflared-linux-arm64" | awk '{ print $1 }')
cp "$here/../cloudflared.lock" "$tmp/lock"
cp "$tmp/lock" "$tmp/lock.orig"
run() { RENOX_CLOUDFLARED_LOCK=$tmp/lock RENOX_CLOUDFLARED_MIRROR=file://$tmp/mirror "$@"; }

# 1. A bad version: refused, the lock unchanged.
if run "$pin" 2026.10 2>"$tmp/err"; then fail "a malformed version is refused"
elif cmp -s "$tmp/lock" "$tmp/lock.orig"; then pass "a malformed version is refused, the lock unchanged"
else fail "a malformed version changed the lock"; fi

# 2. A missing asset: refused, the lock unchanged.
if run "$pin" 2099.9.9 2>"$tmp/err"; then fail "a missing release is refused"
elif grep -q "download of" "$tmp/err" && cmp -s "$tmp/lock" "$tmp/lock.orig"; then pass "a missing release is refused, the lock unchanged"
else fail "a missing release: $(cat "$tmp/err")"; fi

# 3. Two downloads that differ (a curl stub that appends a byte on every
#    second call): refused, the lock unchanged.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
n=$(cat "$CURL_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$CURL_COUNT"
out=""; args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do [[ ${args[i]} == --output ]] && out=${args[i+1]}; done
url=${args[${#args[@]}-1]}
cp "${url#file://}" "$out"
if (( n % 2 == 0 )); then printf 'x' >> "$out"; fi
STUB
chmod +x "$tmp/bin/curl"
if PATH="$tmp/bin:$PATH" CURL_COUNT=$tmp/count run "$pin" "$version" 2>"$tmp/err"; then fail "two different downloads are refused"
elif grep -q "differ" "$tmp/err" && cmp -s "$tmp/lock" "$tmp/lock.orig"; then pass "two downloads that differ are refused, nothing written"
else fail "two different downloads: $(cat "$tmp/err")"; fi

# 4. Matching downloads: the new pin, every target, the date; fetch accepts it.
if run "$pin" "$version" >"$tmp/out" 2>"$tmp/err"; then
  if grep -qx "version $version" "$tmp/lock" \
    && grep -qx "x86_64-unknown-linux-gnu  $amd  cloudflared-linux-amd64" "$tmp/lock" \
    && grep -qx "aarch64-unknown-linux-gnu  $arm  cloudflared-linux-arm64" "$tmp/lock" \
    && grep -q "two downloads that matched ($(date -u +%Y-%m-%d))" "$tmp/lock" \
    && [[ $(grep -c . "$tmp/lock") == $(grep -c . "$tmp/lock.orig") ]]; then
    pass "matching downloads pin the version, both digests and today's date"
  else fail "the rewritten lock: $(cat "$tmp/lock")"; fi
else fail "matching downloads: $(cat "$tmp/err")"; fi
for target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
  if path=$(run "$fetch" "$target" "$tmp/fetch-$target" 2>"$tmp/err") && [[ -x $path ]]; then pass "fetch-cloudflared.sh accepts the new pin for $target"
  else fail "fetch with the new pin ($target): $(cat "$tmp/err")"; fi
done

echo
if [[ $failures -eq 0 ]]; then echo "all passed"; else echo "$failures failed"; exit 1; fi
