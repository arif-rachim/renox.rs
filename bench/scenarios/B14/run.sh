#!/usr/bin/env bash
# B14: 10,000 idle WebSocket connections on one tenant (#282;
# docs/14-benchmarks.md): examples/chat on renox-worker, one signed-in user,
# one room. Judged: the worker's RSS growth (target <= 50 MB, red line
# 150 MB) and the isolate heap seen by a page request before and after
# (unchanged: connections live in the Rust hub, not in the isolate).
# B14_CONNECTIONS (default 10000) and B14_HOLD_S (default 10) override.
set -euo pipefail
: "${BENCH_OUT:?run through bench/run.sh}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lib="$here/../../lib"
command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
n=${B14_CONNECTIONS:-10000}
hold=${B14_HOLD_S:-10}
need=$((n + 1000))
if [[ $(ulimit -n) != unlimited && $(ulimit -n) -lt $need ]]; then
  echo "error: B14 needs ulimit -n >= $need (now $(ulimit -n))" >&2
  exit 1
fi
runs=${BENCH_RUNS:-1}
deltas=()
heaps=()
# A fresh worker per run: RSS a process once grew to stays with it.
for i in $(seq 1 "$runs"); do
  work=$(mktemp -d)
  trap '"$lib/worker.sh" stop "$work" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
  port=$((20000 + RANDOM % 20000))
  echo "chat.bench.test t_chat chat" >"$work/tenants.txt"
  "$lib/worker.sh" setup "$work" "$port" 600 "$work/tenants.txt" >/dev/null
  # One tenant holds every connection: lift the per-tenant and per-user caps.
  cat >>"$work/worker.toml" <<TOML

[realtime]
free_connections = $need
paid_connections = $need
user_connections = $need
TOML
  "$lib/worker.sh" start "$work" >/dev/null
  bun "$lib/ws-load.ts" "$work" "$port" chat.bench.test "$n" "$hold" "$work/run-$i.json" >&2
  deltas+=("$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$work/run-$i.json','utf8')).rss_delta_mb)")")
  heaps+=("$(bun -e "const r=JSON.parse(require('fs').readFileSync('$work/run-$i.json','utf8'));console.log(r.heap_delta_mb ?? 0)")")
  cp "$work/run-$i.json" "${BENCH_OUT%.json}.run-$i.json"
  "$lib/worker.sh" stop "$work" >/dev/null 2>&1 || true
  rm -rf "$work"
done
deltas_json=$(printf '%s\n' "${deltas[@]}" | paste -sd, -)
heaps_json=$(printf '%s\n' "${heaps[@]}" | paste -sd, -)
bun -e "
const d=[$deltas_json].sort((a,b)=>a-b); const h=[$heaps_json].sort((a,b)=>a-b);
const med=(x)=>x[Math.floor((x.length-1)/2)];
const out={id:'B14',notes:'examples/chat, $n idle connections, one user, one room, held ${hold} s; worker '+(process.env.RENOX_WORKER_PATH?'from RENOX_WORKER_PATH':'release build'),samples:{rss_delta_mb:d,heap_delta_mb:h},summary:{rss_delta_mb:med(d),heap_delta_mb:med(h)}};
require('fs').writeFileSync('$BENCH_OUT', JSON.stringify(out,null,2));
"
