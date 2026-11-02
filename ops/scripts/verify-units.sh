#!/usr/bin/env bash
# systemd-analyze verify over ops/systemd/* (#252, #366). The units name
# binaries under /opt/renox/bin (renox-worker, litestream, and on the single
# host cloudflared, bun and the timers' scripts), which verify requires to
# exist; on a machine without them (CI, a laptop) this script puts empty
# placeholders there for the run and removes them afterwards.
# Needs root or sudo for /opt/renox/bin. Exit code: that of verify.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sudo_cmd=()
if [[ $(id -u) -ne 0 ]]; then sudo_cmd=(sudo); fi

created=()
cleanup() {
  for f in "${created[@]}"; do "${sudo_cmd[@]}" rm -f "$f"; done
}
trap cleanup EXIT

"${sudo_cmd[@]}" install -d -m 0755 /opt/renox/bin
# Every /opt/renox/bin/<name> an ExecStart= of a unit names.
mapfile -t bins < <(grep -ho '^ExecStart=/opt/renox/bin/[A-Za-z0-9._-]*' "$here"/systemd/*.service | sed 's|^ExecStart=/opt/renox/bin/||' | sort -u)
for bin in "${bins[@]}"; do
  path=/opt/renox/bin/$bin
  if [[ ! -e $path ]]; then
    printf '#!/bin/sh\nexit 0\n' | "${sudo_cmd[@]}" tee "$path" >/dev/null
    "${sudo_cmd[@]}" chmod 0755 "$path"
    created+=("$path")
  fi
done

# Template units are verified through one instance each.
tmp=$(mktemp -d)
trap 'cleanup; rm -rf "$tmp"' EXIT
units=()
for f in "$here"/systemd/*.service "$here"/systemd/*.slice "$here"/systemd/*.target "$here"/systemd/*.timer; do
  name=$(basename "$f")
  if [[ $name == *@.service ]]; then
    inst="${name%@.service}@t_verify.service"
    cp "$f" "$tmp/$inst"
    units+=("$tmp/$inst")
  else
    units+=("$f")
  fi
done
systemd-analyze verify "${units[@]}"
echo "systemd-analyze verify: ${#units[@]} units ok"
