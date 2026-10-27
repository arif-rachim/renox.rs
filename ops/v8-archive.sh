#!/usr/bin/env bash
# Verified prebuilt rusty_v8 archive (issue #109; docs/24-threat-model.md F,
# "Tampered prebuilt rusty_v8 binary"). The `v8` crate's build script would
# download the archive itself and check nothing; CI downloads it here, checks
# it against ops/v8-checksums.txt, and hands the verified file to the build
# through RUSTY_V8_ARCHIVE. Any mismatch fails before cargo runs.
#
#   ops/v8-archive.sh fetch <target> <dir>
#       Download the archive for the v8 version in Cargo.lock and <target>
#       into <dir>, verify it, print its absolute path.
#   ops/v8-archive.sh verify <file> <entry>
#       Check <file> against the checksum of <entry>
#       (v<version>/<archive name>, as listed in ops/v8-checksums.txt).
#
# Environment:
#   RENOX_V8_MIRROR     base URL of the archive mirror (default: the upstream
#                       GitHub releases). Not RUSTY_V8_MIRROR: the v8 build
#                       script reads that one and downloads more files from it.
#   RENOX_V8_CHECKSUMS  checksum file (default: ops/v8-checksums.txt)
#   RENOX_CARGO_LOCK    lockfile to read the v8 version from (default: Cargo.lock)
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
checksums=${RENOX_V8_CHECKSUMS:-$repo/ops/v8-checksums.txt}
lockfile=${RENOX_CARGO_LOCK:-$repo/Cargo.lock}
mirror=${RENOX_V8_MIRROR:-https://github.com/denoland/rusty_v8/releases/download}

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: ops/v8-archive.sh fetch <target> <dir> | verify <file> <entry>" >&2
  exit 2
}

# Expected sha256 of one entry; exactly one line must match.
expected_sum() {
  local entry=$1 sums
  sums=$(awk -v e="$entry" '!/^#/ && NF == 2 && $2 == e { print $1 }' "$checksums")
  [[ -n "$sums" ]] || die "no checksum for $entry in $checksums; add one (ops/README.md)"
  [[ $(wc -l <<<"$sums") -eq 1 ]] || die "more than one checksum for $entry in $checksums"
  echo "$sums"
}

verify() {
  local file=$1 entry=$2 want got
  want=$(expected_sum "$entry")
  got=$(sha256sum "$file" | awk '{ print $1 }')
  if [[ "$got" != "$want" ]]; then
    die "rusty_v8 archive checksum mismatch for $entry: expected $want, got $got ($file). Do not build with it."
  fi
  echo "rusty_v8 archive verified: $entry sha256 $got" >&2
}

# The single v8 version in the lockfile; two would link two V8s.
v8_version() {
  local versions
  versions=$(awk '/^\[\[package\]\]/ { name = "" } /^name = / { name = $3 } /^version = / && name == "\"v8\"" { gsub(/"/, "", $3); print $3 }' "$lockfile")
  [[ -n "$versions" ]] || die "no v8 package in $lockfile"
  [[ $(wc -l <<<"$versions") -eq 1 ]] || die "more than one v8 version in $lockfile: $(tr '\n' ' ' <<<"$versions")"
  echo "$versions"
}

fetch() {
  local target=$1 dir=$2 version entries entry name out
  version=$(v8_version)
  # The archive name carries the v8 crate's feature suffix (for example
  # _simdutf); the checksum file names the one archive per version and target.
  entries=$(awk -v v="v$version/" -v t="_release_$target.a.gz" \
    '!/^#/ && NF == 2 && index($2, v) == 1 && substr($2, length($2) - length(t) + 1) == t { print $2 }' "$checksums")
  [[ -n "$entries" ]] || die "no checksum for v8 $version on $target in $checksums; add one (ops/README.md)"
  [[ $(wc -l <<<"$entries") -eq 1 ]] || die "more than one archive for v8 $version on $target in $checksums"
  entry=$entries
  name=${entry#*/}
  mkdir -p "$dir"
  out="$(cd "$dir" && pwd)/$name"
  curl -fsSL --retry 3 -o "$out.part" "$mirror/$entry" || die "download failed: $mirror/$entry"
  (verify "$out.part" "$entry") || {
    rm -f "$out.part"
    exit 1
  }
  mv "$out.part" "$out"
  echo "$out"
}

[[ $# -ge 1 ]] || usage
case "$1" in
  fetch)
    [[ $# -eq 3 ]] || usage
    fetch "$2" "$3"
    ;;
  verify)
    [[ $# -eq 3 ]] || usage
    [[ -f "$2" ]] || die "no such file: $2"
    verify "$2" "$3"
    ;;
  *) usage ;;
esac
