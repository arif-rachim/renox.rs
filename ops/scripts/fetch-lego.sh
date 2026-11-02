#!/usr/bin/env bash
# Downloads the lego release pinned in ops/lego.lock for one target, verifies
# the tarball's SHA-256 before anything is extracted, and prints the path of
# the extracted `lego` binary (#366).
#
#   ops/scripts/fetch-lego.sh <rust target> <dest dir>
#
# RENOX_LEGO_MIRROR replaces https://github.com/go-acme/lego/releases/download
# (same layout: <base>/v<version>/<tarball>; file:// works, which the tests use).
# RENOX_LEGO_LOCK replaces ops/lego.lock (tests only).
set -euo pipefail

usage() { echo "usage: $0 <rust target> <dest dir>" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
target=$1
dest=$2

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock=${RENOX_LEGO_LOCK:-$here/lego.lock}
mirror=${RENOX_LEGO_MIRROR:-https://github.com/go-acme/lego/releases/download}

version=$(awk '$1 == "version" { print $2 }' "$lock")
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "fetch-lego: no version line like 4.35.0 in $lock" >&2
  exit 1
fi
read -r expected tarball < <(awk -v t="$target" '$1 == t { print $2, $3 }' "$lock") || true
if [[ -z ${expected:-} || -z ${tarball:-} ]]; then
  echo "fetch-lego: no entry for target $target in $lock" >&2
  exit 1
fi
if [[ ! $expected =~ ^[0-9a-f]{64}$ ]]; then
  echo "fetch-lego: the entry for $target is not a SHA-256" >&2
  exit 1
fi

mkdir -p "$dest"
work=$(mktemp -d "$dest/.fetch.XXXXXX")
trap 'rm -rf "$work"' EXIT

curl --fail --silent --show-error --location --proto '=https,file' --retry 3 \
  --output "$work/$tarball" "$mirror/v$version/$tarball"

actual=$(sha256sum "$work/$tarball" | awk '{ print $1 }')
if [[ $actual != "$expected" ]]; then
  echo "fetch-lego: checksum mismatch for $tarball: expected $expected, got $actual" >&2
  exit 1
fi

# Only the one file is extracted, so a tarball cannot write elsewhere.
tar -xzf "$work/$tarball" -C "$work" --no-same-owner --no-same-permissions lego
if [[ ! -f $work/lego || -L $work/lego ]]; then
  echo "fetch-lego: $tarball has no regular file named lego" >&2
  exit 1
fi
chmod 0755 "$work/lego"
mv -f "$work/lego" "$dest/lego"
echo "$dest/lego"
