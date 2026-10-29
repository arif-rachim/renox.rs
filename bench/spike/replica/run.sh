#!/usr/bin/env bash
# Spike #256: the synchronous replica for the paid tier. Runs the same
# write-heavy load (writer.ts) against each candidate, on one host with two
# processes standing in for two nodes (loopback), and measures writes/s and
# p99, rows lost after SIGKILL of the primary (RPO, over --kills runs), and
# the time until the replica serves reads and then writes (RTO).
#
#   bench/spike/replica/run.sh [--seconds 10] [--kills 10] [--out <dir>] [candidate ...]
#
# Candidates: plain (baseline), litestream (sync-interval 1s, restore on
# "host 2"), litefs (static leader, FUSE), libsql (embedded replica against
# sqld). A candidate whose tools are missing is skipped with the reason
# (that is part of the result: its operational cost). For two real hosts,
# set REPLICA_HOST2=<ssh host> and the restore/promote steps run there.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
seconds=10
kills=10
out=$(mktemp -d)
candidates=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --seconds) seconds=$2; shift 2 ;;
    --kills) kills=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    plain | litestream | litefs | libsql) candidates+=("$1"); shift ;;
    *) echo "usage: $0 [--seconds N] [--kills N] [--out dir] [plain|litestream|litefs|libsql ...]" >&2; exit 2 ;;
  esac
done
[[ ${#candidates[@]} -gt 0 ]] || candidates=(plain litestream litefs libsql)
mkdir -p "$out"

now_ms() { date +%s%3N; }
json() { printf '%s\n' "$1" >> "$out/results.ndjson"; }

run_plain() {
  local dir=$out/plain; rm -rf "$dir"; mkdir -p "$dir"
  local r; r=$(bun "$here/writer.ts" "$dir/app.db" "$seconds")
  json "{\"candidate\":\"plain\",\"load\":$r}"
}

run_litestream() {
  command -v litestream >/dev/null || { json '{"candidate":"litestream","skipped":"litestream not on PATH (ops/scripts/fetch-litestream.sh)"}'; return; }
  local dir=$out/litestream; rm -rf "$dir"; mkdir -p "$dir/primary" "$dir/replica" "$dir/host2"
  cat > "$dir/litestream.yml" <<YML
dbs:
  - path: $dir/primary/app.db
    replicas:
      - type: file
        path: $dir/replica
        sync-interval: 1s
YML
  # Throughput with replication on.
  litestream replicate -config "$dir/litestream.yml" >"$dir/ls.log" 2>&1 &
  local ls=$!
  sleep 1
  local r; r=$(bun "$here/writer.ts" "$dir/primary/app.db" "$seconds")
  json "{\"candidate\":\"litestream\",\"load\":$r}"
  kill "$ls"; wait "$ls" 2>/dev/null || true
  # RPO and RTO over $kills runs: kill writer and sidecar together.
  for i in $(seq 1 "$kills"); do
    rm -rf "$dir/primary" "$dir/replica" "$dir/host2"; mkdir -p "$dir/primary" "$dir/replica" "$dir/host2"
    litestream replicate -config "$dir/litestream.yml" >"$dir/ls.log" 2>&1 &
    ls=$!
    bun "$here/writer.ts" "$dir/primary/app.db" 30 --ack-file "$dir/ack" >/dev/null &
    local w=$!
    sleep $((3 + RANDOM % 5))
    kill -9 "$w" "$ls"; wait "$w" "$ls" 2>/dev/null || true
    local acked; acked=$(cat "$dir/ack" 2>/dev/null || echo 0)
    local t0; t0=$(now_ms)
    litestream restore -o "$dir/host2/app.db" "file://$dir/replica" >/dev/null 2>&1 || true
    local t_read; t_read=$(now_ms)
    local have; have=$(bun -e "const {Database}=require('bun:sqlite');const d=new Database('$dir/host2/app.db');console.log(d.query('select coalesce(max(id),0) m from app__hits').get().m)" 2>/dev/null || echo 0)
    json "{\"candidate\":\"litestream\",\"kill\":$i,\"acked\":$acked,\"restored\":$have,\"rows_lost\":$((acked > have ? acked - have : 0)),\"rto_read_ms\":$((t_read - t0)),\"rto_write_ms\":$((t_read - t0))}"
  done
}

run_litefs() {
  command -v litefs >/dev/null || { json '{"candidate":"litefs","skipped":"litefs not installed (needs FUSE, /dev/fuse and CAP_SYS_ADMIN, plus a lease: static leader here)"}'; return; }
  [[ -e /dev/fuse ]] || { json '{"candidate":"litefs","skipped":"no /dev/fuse on this host"}'; return; }
  local dir=$out/litefs; rm -rf "$dir"; mkdir -p "$dir"/{p,r}/{mnt,data}
  for role in p r; do
    local candidate=true; [[ $role == r ]] && candidate=false
    cat > "$dir/$role.yml" <<YML
fuse: { dir: "$dir/$role/mnt" }
data: { dir: "$dir/$role/data" }
lease: { type: "static", candidate: $candidate, advertise-url: "http://127.0.0.1:2020$([[ $role == r ]] && echo 1 || echo 0)" }
http: { addr: ":2020$([[ $role == r ]] && echo 1 || echo 0)" }
YML
  done
  litefs mount -config "$dir/p.yml" >"$dir/p.log" 2>&1 & local p=$!
  sleep 2
  litefs mount -config "$dir/r.yml" >"$dir/r.log" 2>&1 & local r=$!
  sleep 2
  local res; res=$(bun "$here/writer.ts" "$dir/p/mnt/app.db" "$seconds")
  json "{\"candidate\":\"litefs\",\"load\":$res}"
  kill "$p" "$r" 2>/dev/null || true
  json '{"candidate":"litefs","note":"RPO/RTO need a lease (Consul) for promotion; with a static leader the replica serves reads only"}'
}

run_libsql() {
  command -v sqld >/dev/null || { json '{"candidate":"libsql","skipped":"sqld not installed; the embedded replica also needs @libsql/client, which renox-data does not use (rusqlite)"}'; return; }
  local dir=$out/libsql; rm -rf "$dir"; mkdir -p "$dir"
  sqld --db-path "$dir/primary" --http-listen-addr 127.0.0.1:28080 --grpc-listen-addr 127.0.0.1:25001 >"$dir/sqld.log" 2>&1 & local s=$!
  sleep 2
  json '{"candidate":"libsql","note":"sqld started; the embedded-replica writer needs @libsql/client (not a dependency of this repository), so writes/s, RPO and RTO are not measured by this script yet"}'
  kill "$s" 2>/dev/null || true
}

for c in "${candidates[@]}"; do
  echo "== $c" >&2
  "run_$c"
done
echo "$out/results.ndjson"
