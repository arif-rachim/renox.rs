#!/usr/bin/env bash
# Downloads the Litestream release pinned in ops/litestream.lock for one
# target, verifies the tarball's SHA-256 before anything is extracted, and
# prints the path of the extracted `litestream` binary (#252).
#
#   ops/scripts/fetch-litestream.sh <rust target> <dest dir>
#
# RENOX_LITESTREAM_MIRROR replaces https://github.com/benbjohnson/litestream/releases/download
# (same layout: <base>/v<version>/<tarball>; file:// works, which the tests use).
# RENOX_LITESTREAM_LOCK replaces ops/litestream.lock (tests only).
set -euo pipefail

usage() { echo "usage: $0 <rust target> <dest dir>" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
target=$1
dest=$2

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock=${RENOX_LITESTREAM_LOCK:-$here/litestream.lock}
mirror=${RENOX_LITESTREAM_MIRROR:-https://github.com/benbjohnson/litestream/releases/download}

version=$(awk '$1 == "version" { print $2 }' "$lock")
if [[ -z $version ]]; then
  echo "fetch-litestream: no version line in $lock" >&2
  exit 1
fi
read -r expected tarball < <(awk -v t="$target" '$1 == t { print $2, $3 }' "$lock") || true
if [[ -z ${expected:-} || -z ${tarball:-} ]]; then
  echo "fetch-litestream: no entry for target $target in $lock" >&2
  exit 1
fi
if [[ ! $expected =~ ^[0-9a-f]{64}$ ]]; then
  echo "fetch-litestream: the entry for $target is not a SHA-256" >&2
  exit 1
fi

mkdir -p "$dest"
work=$(mktemp -d "$dest/.fetch.XXXXXX")
trap 'rm -rf "$work"' EXIT

curl --fail --silent --show-error --location --proto '=https,file' --retry 3 \
  --output "$work/$tarball" "$mirror/v$version/$tarball"

actual=$(sha256sum "$work/$tarball" | awk '{ print $1 }')
if [[ $actual != "$expected" ]]; then
  echo "fetch-litestream: checksum mismatch for $tarball: expected $expected, got $actual" >&2
  exit 1
fi

# Only the one file is extracted, so a tarball cannot write elsewhere.
tar -xzf "$work/$tarball" -C "$work" --no-same-owner --no-same-permissions litestream
if [[ ! -f $work/litestream || -L $work/litestream ]]; then
  echo "fetch-litestream: $tarball has no regular file named litestream" >&2
  exit 1
fi
chmod 0755 "$work/litestream"
mv -f "$work/litestream" "$dest/litestream"
echo "$dest/litestream"
