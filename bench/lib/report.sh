#!/usr/bin/env bash
# Prints the result markdown (docs/14-benchmarks.md, "Recording results") for
# one raw result file. Usage: report.sh <raw.json> <hw.json>
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ $# -ne 2 ]]; then
  echo "usage: $0 <raw.json> <hw.json>" >&2
  exit 2
fi
exec bun "$here/report.ts" "$1" "$2" "$here/../targets.json"
