#!/usr/bin/env bash
# Starts the Bun + Hono baseline in the foreground. PORT defaults to 8787.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[[ -d "$here/node_modules" ]] || (cd "$here" && bun install --frozen-lockfile >/dev/null)
exec bun "$here/start-bun.ts"
