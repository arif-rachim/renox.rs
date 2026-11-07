#!/usr/bin/env bash
# Test of fetch_worker in bootstrap-node.sh (#525), run by CI's ops step: no
# Docker, no network. A file:// release is built in a temp dir
# (RENOX_RELEASE_BASE, layout <base>/worker-v<version>/<asset>).
# Proves: the pdf variant downloads renox-worker-<v>-<target>-pdf.gz, checks
# the .gz against its .sha256 and writes the gunzipped bytes; the default
# variant writes the plain asset; a wrong .sha256 fails and writes nothing;
# an unknown --worker-variant is refused by the script.
set -euo pipefail

scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

# shellcheck source=bootstrap-node.sh
source "$scripts/bootstrap-node.sh"

version=9.9.9
target=$(worker_target)
rel=$tmp/release/worker-v$version
mkdir -p "$rel"
printf 'plain worker bytes\n' > "$rel/renox-worker-$version-$target"
printf 'pdf worker bytes\n' > "$tmp/pdf-plain"
gzip -c "$tmp/pdf-plain" > "$rel/renox-worker-$version-$target-pdf.gz"
for f in "$rel/renox-worker-$version-$target" "$rel/renox-worker-$version-$target-pdf.gz"; do
  printf '%s  %s\n' "$(sha256sum "$f" | awk '{ print $1 }')" "$(basename "$f")" > "$f.sha256"
done
export RENOX_RELEASE_BASE=file://$tmp/release

# 1. pdf: the unpacked bytes are installed.
if (fetch_worker "$version" pdf "$tmp/out-pdf") 2>"$tmp/err" && cmp -s "$tmp/out-pdf" "$tmp/pdf-plain"; then
  pass "pdf variant writes the gunzipped bytes"
else
  fail "pdf variant writes the gunzipped bytes"; cat "$tmp/err" >&2
fi

# 2. default: the plain asset.
if (fetch_worker "$version" default "$tmp/out-default") 2>"$tmp/err" && cmp -s "$tmp/out-default" "$rel/renox-worker-$version-$target"; then
  pass "default variant writes the plain asset"
else
  fail "default variant writes the plain asset"; cat "$tmp/err" >&2
fi

# 3. A wrong .sha256 fails and writes nothing.
printf '%064d  x\n' 0 > "$rel/renox-worker-$version-$target-pdf.gz.sha256"
if (fetch_worker "$version" pdf "$tmp/out-bad") 2>"$tmp/err"; then
  fail "a wrong .sha256 fails"
elif [[ -e $tmp/out-bad ]]; then
  fail "a wrong .sha256 installs nothing"
elif grep -q 'checksum mismatch' "$tmp/err"; then
  pass "a wrong .sha256 fails and installs nothing"
else
  fail "a wrong .sha256 fails with a checksum message"; cat "$tmp/err" >&2
fi

# 4. A .sha256 that is not a digest fails.
printf 'not a digest\n' > "$rel/renox-worker-$version-$target-pdf.gz.sha256"
if (fetch_worker "$version" pdf "$tmp/out-bad2") 2>/dev/null || [[ -e $tmp/out-bad2 ]]; then
  fail "a malformed .sha256 fails"
else
  pass "a malformed .sha256 fails"
fi

# 5. The script refuses an unknown variant (before it needs root).
if bash "$scripts/bootstrap-node.sh" --worker-variant fancy --worker-version 1.2.3 2>"$tmp/err"; then
  fail "an unknown --worker-variant is refused"
elif grep -q -- '--worker-variant must be default or pdf' "$tmp/err"; then
  pass "an unknown --worker-variant is refused"
else
  fail "an unknown --worker-variant is refused with its message"; cat "$tmp/err" >&2
fi

[[ $failures -eq 0 ]] || { echo "$failures failure(s)" >&2; exit 1; }
echo "bootstrap-worker-variant: all passed"
