#!/usr/bin/env bash
# Moves ops/cloudflared.lock to another cloudflared release (#547; ops/README.md,
# "cloudflared and lego"). Upstream publishes no checksum file for the bare
# binaries, so each target's asset is downloaded twice, in two separate
# requests, and the pin is written only when both SHA-256 digests match:
#
#   ops/scripts/pin-cloudflared.sh <version>       # e.g. 2026.10.7
#
# Rewrites the version line, the digest of every target already in the lock
# and the date in its header; the targets and asset names stay. Nothing is
# written when a download fails or two downloads differ. Then run
# ops/scripts/fetch-cloudflared.test.sh and `fetch-cloudflared.sh` for one
# target, and open a PR with the upstream RELEASE_NOTES between the versions.
# RENOX_CLOUDFLARED_MIRROR and RENOX_CLOUDFLARED_LOCK as in fetch-cloudflared.sh.
set -euo pipefail

die() { echo "pin-cloudflared: $*" >&2; exit 1; }
[[ $# -eq 1 ]] || { echo "usage: $0 <version>" >&2; exit 2; }
version=$1
[[ $version =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$ ]] || die "the version must look like 2026.10.7"

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lock=${RENOX_CLOUDFLARED_LOCK:-$here/cloudflared.lock}
mirror=${RENOX_CLOUDFLARED_MIRROR:-https://github.com/cloudflare/cloudflared/releases/download}
[[ -f $lock ]] || die "$lock does not exist"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

download() {
  curl --fail --silent --show-error --location --proto '=https,file' --retry 3 --output "$2" "$1" \
    || die "download of $1 failed"
}

mapfile -t entries < <(awk '$1 ~ /-linux-/ && NF == 3 { print $1, $3 }' "$lock")
[[ ${#entries[@]} -gt 0 ]] || die "no target lines in $lock"
declare -A sums=()
for entry in "${entries[@]}"; do
  read -r target asset <<< "$entry"
  [[ $asset =~ ^cloudflared-linux-[a-z0-9]+$ ]] || die "the asset name for $target is not cloudflared-linux-<arch>"
  download "$mirror/$version/$asset" "$work/$asset.1"
  download "$mirror/$version/$asset" "$work/$asset.2"
  a=$(sha256sum "$work/$asset.1" | awk '{ print $1 }')
  b=$(sha256sum "$work/$asset.2" | awk '{ print $1 }')
  [[ $a == "$b" ]] || die "two downloads of $asset differ ($a, $b); nothing written"
  sums[$target]=$a
  echo "pin-cloudflared: $target $asset $a"
done

today=$(date -u +%Y-%m-%d)
out=$work/lock
while IFS= read -r line; do
  read -r first _ third _ <<< "$line" || true
  if [[ $first == version ]]; then
    echo "version $version"
  elif [[ -n ${sums[$first]:-} && -n ${third:-} ]]; then
    printf '%s  %s  %s\n' "$first" "${sums[$first]}" "$third"
  elif [[ $line =~ ^(.*two\ downloads\ that\ matched\ \()[0-9]{4}-[0-9]{2}-[0-9]{2}(\).*)$ ]]; then
    echo "${BASH_REMATCH[1]}$today${BASH_REMATCH[2]}"
  else
    printf '%s\n' "$line"
  fi
done < "$lock" > "$out"
cat "$out" > "$lock"
echo "pin-cloudflared: $lock pins $version"
