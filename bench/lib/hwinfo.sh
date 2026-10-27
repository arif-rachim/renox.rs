#!/usr/bin/env bash
# Prints hardware and tool versions as one JSON object, for the
# "Hardware:" line of every result (docs/14-benchmarks.md, "Reference hardware").
set -euo pipefail

# Escape a string for a JSON string literal.
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/ }
  s=${s//$'\n'/ }
  printf '"%s"' "$s"
}

# First line of `<cmd> --version`, or null when the tool is missing.
version_of() {
  if command -v "$1" >/dev/null 2>&1; then
    json_str "$("$1" --version 2>/dev/null | head -n 1)"
  else
    printf 'null'
  fi
}

cpu=unknown
if command -v lscpu >/dev/null 2>&1; then
  cpu=$(lscpu | awk -F: '/^Model name/ { sub(/^[ \t]+/, "", $2); print $2; exit }')
elif command -v sysctl >/dev/null 2>&1; then
  cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)
fi
cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)

ram_mb=0
if [[ -r /proc/meminfo ]]; then
  ram_mb=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo)
elif command -v sysctl >/dev/null 2>&1; then
  ram_mb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 ))
fi

git_sha=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

printf '{'
printf '"cpu":%s,' "$(json_str "${cpu:-unknown}")"
printf '"cpus":%d,' "$cpus"
printf '"ram_mb":%d,' "$ram_mb"
printf '"kernel":%s,' "$(json_str "$(uname -sr)")"
printf '"rustc":%s,' "$(version_of rustc)"
printf '"cargo":%s,' "$(version_of cargo)"
printf '"bun":%s,' "$(version_of bun)"
printf '"node":%s,' "$(version_of node)"
printf '"deno":%s,' "$(version_of deno)"
printf '"git":%s' "$(json_str "$git_sha")"
printf '}\n'
