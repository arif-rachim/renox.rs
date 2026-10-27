#!/usr/bin/env bash
# Linker driver for x86_64 Linux: mold if installed, else lld.
# rustc (1.90+) already links with its bundled rust-lld by passing
# `-B<sysroot>/gcc-ld -fuse-ld=lld`; when mold is on PATH those two flags are
# replaced by `-fuse-ld=mold`. Install instructions: bench/README.md.
set -euo pipefail

if ! command -v mold >/dev/null 2>&1; then
  exec cc "$@"
fi

args=()
for arg in "$@"; do
  case "$arg" in
    -fuse-ld=*) ;;
    -B*/gcc-ld) ;;
    *) args+=("$arg") ;;
  esac
done
exec cc -fuse-ld=mold "${args[@]}"
