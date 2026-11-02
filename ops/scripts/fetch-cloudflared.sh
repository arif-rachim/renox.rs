#!/usr/bin/env bash
# Downloads the cloudflared release pinned in ops/cloudflared.lock for one
# target, verifies its SHA-256 before it is made executable, and prints the
# path of the installed `cloudflared` binary (#366).
#
#   ops/scripts/fetch-cloudflared.sh <rust target> <dest dir>
#
# RENOX_CLOUDFLARED_MIRROR replaces https://github.com/cloudflare/cloudflared/releases/download
# (same layout: <base>/<version>/<asset>, no "v" prefix; file:// works, which the tests use).
# RENOX_CLOUDFLARED_LOCK replaces ops/cloudflared.lock (tests only).
set -euo pipefail

usage() { echo "usage: $0 <rust target> <dest dir>" >&2; exit 2; }
[[ $# -eq 2 ]] || usage
target=$1
dest=$2

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock=${RENOX_CLOUDFLARED_LOCK:-$here/cloudflared.lock}
mirror=${RENOX_CLOUDFLARED_MIRROR:-https://github.com/cloudflare/cloudflared/releases/download}

version=$(awk '$1 == "version" { print $2 }' "$lock")
if [[ ! $version =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$ ]]; then
  echo "fetch-cloudflared: no version line like 2026.10.0 in $lock" >&2
  exit 1
fi
read -r expected asset < <(awk -v t="$target" '$1 == t { print $2, $3 }' "$lock") || true
if [[ -z ${expected:-} || -z ${asset:-} ]]; then
  echo "fetch-cloudflared: no entry for target $target in $lock" >&2
  exit 1
fi
if [[ ! $expected =~ ^[0-9a-f]{64}$ ]]; then
  echo "fetch-cloudflared: the entry for $target is not a SHA-256" >&2
  exit 1
fi
if [[ ! $asset =~ ^cloudflared-linux-[a-z0-9]+$ ]]; then
  echo "fetch-cloudflared: the asset name for $target is not cloudflared-linux-<arch>" >&2
  exit 1
fi

mkdir -p "$dest"
work=$(mktemp -d "$dest/.fetch.XXXXXX")
trap 'rm -rf "$work"' EXIT

curl --fail --silent --show-error --location --proto '=https,file' --retry 3 \
  --output "$work/$asset" "$mirror/$version/$asset"

actual=$(sha256sum "$work/$asset" | awk '{ print $1 }')
if [[ $actual != "$expected" ]]; then
  echo "fetch-cloudflared: checksum mismatch for $asset: expected $expected, got $actual" >&2
  exit 1
fi

chmod 0755 "$work/$asset"
mv -f "$work/$asset" "$dest/cloudflared"
echo "$dest/cloudflared"
