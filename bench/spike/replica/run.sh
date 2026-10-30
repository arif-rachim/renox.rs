#!/usr/bin/env bash
# Spike #256: the synchronous replica for the paid tier. Runs the same
# write-heavy load (writer.ts) against each candidate, on one host with two
# processes standing in for two nodes (loopback), and measures writes/s and
# p99, rows lost after SIGKILL of the primary (RPO, over --kills runs), and
# the time until the replica serves reads and then writes (RTO).
#
#   bench/spike/replica/run.sh [--seconds 10] [--kills 10] [--kill-rate 0] [--out <dir>] [candidate ...]
#
# --kill-rate N: the kill runs write at most N rows per second (0: as fast as
# each candidate allows). The candidates saturate at very different rates, so
# RPO is compared at one offered load; the throughput run is always unlimited.
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
kill_rate=0
out=$(mktemp -d)
candidates=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --seconds) seconds=$2; shift 2 ;;
    --kills) kills=$2; shift 2 ;;
    --kill-rate) kill_rate=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    plain | litestream | litefs | libsql) candidates+=("$1"); shift ;;
    *) echo "usage: $0 [--seconds N] [--kills N] [--kill-rate N] [--out dir] [plain|litestream|litefs|libsql ...]" >&2; exit 2 ;;
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

# True once Litestream has written a snapshot under the replica directory $1.
has_snapshot() { [[ -n $(find "$1" -name '*.snapshot.lz4' -print -quit 2>/dev/null) ]]; }

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
    # The tenant's file exists before the load (as a cell's does), and the
    # sidecar has its first snapshot in the replica: otherwise the kill
    # lands before Litestream has replicated anything and measures start-up.
    bun "$here/writer.ts" "$dir/primary/app.db" 0 >/dev/null
    litestream replicate -config "$dir/litestream.yml" >"$dir/ls.log" 2>&1 &
    ls=$!
    if [[ $(wait_ok has_snapshot "$dir/replica") -lt 0 ]]; then
      json "{\"candidate\":\"litestream\",\"kill\":$i,\"error\":\"no snapshot in the replica after 60 s\"}"
      kill "$ls"; wait "$ls" 2>/dev/null || true
      continue
    fi
    bun "$here/writer.ts" "$dir/primary/app.db" 30 --ack-file "$dir/ack" --rate "$kill_rate" >/dev/null &
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

max_id() { bun -e "const {Database}=require('bun:sqlite');const d=new Database('$1',{readonly:true});console.log(d.query('select coalesce(max(id),0) m from app__hits').get().m)" 2>/dev/null || echo 0; }

# One Hrana statement against the sqld on port $1; fails on HTTP or SQL error, prints the response.
hrana() {
  local r; r=$(curl -fs -X POST "http://127.0.0.1:$1/v2/pipeline" -H 'content-type: application/json' -d "{\"requests\":[{\"type\":\"execute\",\"stmt\":{\"sql\":\"$2\"}}]}") || return 1
  [[ $r != *'"type":"error"'* ]] || return 1
  printf '%s' "$r"
}

# Waits until "$@" succeeds (every 20 ms, at most 60 s); prints the ms it took.
wait_ok() {
  local t0; t0=$(now_ms)
  until "$@" >/dev/null 2>&1; do
    (( $(now_ms) - t0 > 60000 )) && { echo -1; return; }
    sleep 0.02
  done
  echo $(( $(now_ms) - t0 ))
}

# LiteFS with a static lease: node p is the primary, node r replicates from
# it (both advertise p's URL). A static lease has no election, so the kill
# runs promote r by restarting it as the candidate, the step Consul would
# automate; RTO includes that restart.
litefs_config() { # <dir> <role> <candidate> <advertised primary port> <own port>
  cat > "$1/$2.yml" <<YML
fuse: { dir: "$1/$2/mnt" }
data: { dir: "$1/$2/data" }
lease: { type: "static", candidate: $3, advertise-url: "http://127.0.0.1:$4" }
http: { addr: "127.0.0.1:$5" }
exit-on-error: false
YML
}

run_litefs() {
  command -v litefs >/dev/null || { json '{"candidate":"litefs","skipped":"litefs not installed (needs FUSE, /dev/fuse and CAP_SYS_ADMIN, plus a lease: static leader here)"}'; return; }
  [[ -e /dev/fuse ]] || { json '{"candidate":"litefs","skipped":"no /dev/fuse on this host"}'; return; }
  local dir=$out/litefs
  litefs_up() {
    for m in "$dir"/{p,r}/mnt; do fusermount3 -uz "$m" 2>/dev/null || true; done
    rm -rf "$dir"; mkdir -p "$dir"/{p,r}/{mnt,data}
    litefs_config "$dir" p true 20200 20200
    litefs_config "$dir" r false 20200 20201
    litefs mount -config "$dir/p.yml" >"$dir/p.log" 2>&1 & lp=$!
    sleep 2
    litefs mount -config "$dir/r.yml" >"$dir/r.log" 2>&1 & lr=$!
    sleep 1
  }
  litefs_down() {
    kill "$lp" "$lr" 2>/dev/null || true; wait "$lp" "$lr" 2>/dev/null || true
    for m in "$dir"/{p,r}/mnt; do fusermount3 -uz "$m" 2>/dev/null || true; done
  }
  local lp lr
  litefs_up
  local res; res=$(bun "$here/writer.ts" "$dir/p/mnt/app.db" "$seconds")
  json "{\"candidate\":\"litefs\",\"load\":$res}"
  litefs_down
  for i in $(seq 1 "$kills"); do
    litefs_up
    bun "$here/writer.ts" "$dir/p/mnt/app.db" 30 --ack-file "$dir/ack" --rate "$kill_rate" >/dev/null 2>&1 &
    local w=$!
    sleep $((3 + RANDOM % 5))
    kill -9 "$w" "$lp"; wait "$w" "$lp" 2>/dev/null || true
    fusermount3 -uz "$dir/p/mnt" 2>/dev/null || true
    local acked; acked=$(cat "$dir/ack" 2>/dev/null || echo 0)
    local t0; t0=$(now_ms)
    # The replica serves reads as it is.
    local have; have=$(max_id "$dir/r/mnt/app.db")
    local t_read; t_read=$(now_ms)
    # Promotion: r restarted as the candidate, advertising itself.
    kill "$lr"; wait "$lr" 2>/dev/null || true
    fusermount3 -uz "$dir/r/mnt" 2>/dev/null || true
    litefs_config "$dir" r true 20201 20201
    litefs mount -config "$dir/r.yml" >"$dir/r2.log" 2>&1 & lr=$!
    local wrote; wrote=$(wait_ok bun -e "const {Database}=require('bun:sqlite');const d=new Database('$dir/r/mnt/app.db');d.exec('pragma busy_timeout=100');d.run('insert into app__hits (at, pad) values (1, \"promoted\")')")
    local t_write; t_write=$(( wrote < 0 ? -1 : $(now_ms) - t0 ))
    json "{\"candidate\":\"litefs\",\"kill\":$i,\"acked\":$acked,\"restored\":$have,\"rows_lost\":$((acked > have ? acked - have : 0)),\"rto_read_ms\":$((t_read - t0)),\"rto_write_ms\":$t_write}"
    litefs_down
  done
}

# libSQL: a `sqld` primary takes the writes over HTTP (the cell would write
# through libSQL, not rusqlite); "host 2" keeps an embedded replica synced
# every 100 ms. After the kill (writer and primary together) the replica
# file serves reads; a new `sqld` on a copy of it takes writes.
run_libsql() {
  command -v sqld >/dev/null || { json '{"candidate":"libsql","skipped":"sqld not installed"}'; return; }
  [[ -d "$here/libsql/node_modules/@libsql/client" ]] || { json '{"candidate":"libsql","skipped":"run bun install in bench/spike/replica/libsql (@libsql/client)"}'; return; }
  local dir=$out/libsql s rp
  libsql_up() {
    rm -rf "$dir"; mkdir -p "$dir/host2"
    sqld --db-path "$dir/primary" --http-listen-addr 127.0.0.1:28080 --grpc-listen-addr 127.0.0.1:25001 --no-welcome >"$dir/sqld.log" 2>&1 & s=$!
    wait_ok hrana 28080 "select 1" >/dev/null
  }
  libsql_up
  local res; res=$(bun "$here/libsql/writer.ts" http://127.0.0.1:28080 "$seconds")
  json "{\"candidate\":\"libsql\",\"load\":$res}"
  kill "$s"; wait "$s" 2>/dev/null || true
  for i in $(seq 1 "$kills"); do
    libsql_up
    bun "$here/libsql/writer.ts" http://127.0.0.1:28080 1 >/dev/null 2>&1
    bun "$here/libsql/replica.ts" "$dir/host2/app.db" http://127.0.0.1:28080 100 >/dev/null 2>&1 & rp=$!
    bun "$here/libsql/writer.ts" http://127.0.0.1:28080 30 --ack-file "$dir/ack" --rate "$kill_rate" >/dev/null 2>&1 &
    local w=$!
    sleep $((3 + RANDOM % 5))
    kill -9 "$w" "$s"; wait "$w" "$s" 2>/dev/null || true
    local acked; acked=$(cat "$dir/ack" 2>/dev/null || echo 0)
    local t0; t0=$(now_ms)
    kill "$rp"; wait "$rp" 2>/dev/null || true
    local have; have=$(max_id "$dir/host2/app.db")
    local t_read; t_read=$(now_ms)
    # Promotion: a new sqld on host 2, seeded with the replica's file and
    # its WAL folded in (VACUUM INTO), which counts in the RTO.
    mkdir -p "$dir/promoted/dbs/default"
    bun -e "const {Database}=require('bun:sqlite');new Database('$dir/host2/app.db').exec(\"vacuum into '$dir/promoted/dbs/default/data'\")"
    sqld --db-path "$dir/promoted" --http-listen-addr 127.0.0.1:28081 --grpc-listen-addr 127.0.0.1:25002 --no-welcome >"$dir/sqld2.log" 2>&1 & local s2=$!
    local wrote; wrote=$(wait_ok hrana 28081 "insert into app__hits (at, pad) values (1, 'promoted')")
    local t_write; t_write=$(( wrote < 0 ? -1 : $(now_ms) - t0 ))
    local after; after=$(hrana 28081 "select max(id) from app__hits" | grep -o '"value":"[0-9]*"' | head -1 | grep -o '[0-9][0-9]*' || echo 0)
    kill "$s2"; wait "$s2" 2>/dev/null || true
    json "{\"candidate\":\"libsql\",\"kill\":$i,\"acked\":$acked,\"restored\":$have,\"rows_lost\":$((acked > have ? acked - have : 0)),\"rto_read_ms\":$((t_read - t0)),\"rto_write_ms\":$t_write,\"promoted_max_id\":${after:-0}}"
  done
}

for c in "${candidates[@]}"; do
  echo "== $c" >&2
  "run_$c"
done
echo "$out/results.ndjson"
