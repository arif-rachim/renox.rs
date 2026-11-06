#!/usr/bin/env bash
# Tests of the local backups without R2 (#517, #516), run by CI's ops step with a
# fake pg_dump and real sqlite3: no network, no Postgres server.
# Proves: with no R2_ENDPOINT, backup-control-db.sh writes
# <dir>/control-db/control-db-<stamp>.dump with mode 0600, logs one line, and
# deletes dumps older than BACKUP_KEEP_DAYS; a failing pg_dump keeps nothing;
# backup-tenant-files.sh copies app.db and a staging <app>.db of a tenant with
# `.backup`, 0600, prunes old copies, never touches secrets.json, and the copy
# of a WAL-mode file that has committed pages in the WAL and a writer with an
# uncommitted transaction passes `pragma quick_check` and holds the committed
# rows only; restore-check.sh exits 1 on a corrupt dump (checked before any
# database is touched, so no server is needed) and on an empty backup dir.
# Threat-model row (docs/24-threat-model.md): "Tenant files or backups read
# from storage" (0600 files in 0700 directories).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
skip() { echo "SKIP backup-local test: $*"; exit 0; }
command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 is not installed"
command -v python3 >/dev/null 2>&1 || skip "python3 is not installed"

tmp=$(mktemp -d)
holder_pid=""
cleanup() { [[ -n $holder_pid ]] && kill "$holder_pid" 2>/dev/null; rm -rf "$tmp"; }
trap cleanup EXIT

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

mkdir -p "$tmp/bin"
printf '#!/bin/sh\nprintf "PGDMP fake dump of %%s\\n" "$*"\n' > "$tmp/bin/pg_dump"
printf '#!/bin/sh\necho "fails" >&2\nexit 3\n' > "$tmp/bin/pg_dump_fail"
chmod 0755 "$tmp/bin/"*
bk=$tmp/backups

# 1. The control database, local mode (no R2_ENDPOINT anywhere).
db() { env -u R2_ENDPOINT -u BACKUP_TARGET PATH="$tmp/bin:$PATH" "$here/backup-control-db.sh" --database renox --backup-dir "$bk" "$@"; }
mkdir -m 0700 "$bk"   # bootstrap-node.sh creates the real one, 0700 root
mkdir -m 0700 "$bk/control-db"
touch -d '20 days ago' "$bk/control-db/control-db-20000101T000000Z.dump"
touch -d '5 days ago' "$bk/control-db/control-db-20000102T000000Z.dump"
if db >"$tmp/out" 2>&1; then pass "local mode runs without any R2 setting"; else fail "local mode: $(cat "$tmp/out")"; fi
file=$(find "$bk/control-db" -type f -newermt '1 minute ago' -name 'control-db-*.dump' | head -n 1)
if [[ -n $file && $file == */control-db-20[0-9][0-9][01][0-9][0-3][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump ]]; then pass "the dump is control-db/control-db-<stamp>.dump"; else fail "dump name: $file"; fi
if [[ -n $file && $(stat -c %a "$file") == 600 && $(stat -c %a "$bk/control-db") == 700 ]]; then pass "the dump is 0600 in a 0700 directory"; else fail "dump mode: $(stat -c %a "$file" 2>&1)"; fi
if grep -q "PGDMP fake dump of --format=custom --compress=6 --dbname=renox" "$file" 2>/dev/null; then pass "the local dump is the plain pg_dump output (no age)"; else fail "dump content"; fi
size=$(stat -c %s "$file")
if [[ $(cat "$tmp/out") == "backup-control-db: renox -> $file ($size bytes)" ]]; then pass "one log line: backup-control-db: renox -> <file> (<bytes> bytes)"; else fail "log line: $(cat "$tmp/out")"; fi
if [[ ! -e $bk/control-db/control-db-20000101T000000Z.dump && -e $bk/control-db/control-db-20000102T000000Z.dump ]]; then pass "a dump older than 14 days is deleted, a newer one kept"; else fail "default retention"; fi
BACKUP_KEEP_DAYS=3 db >"$tmp/out" 2>&1 || fail "run with BACKUP_KEEP_DAYS=3: $(cat "$tmp/out")"
if [[ ! -e $bk/control-db/control-db-20000102T000000Z.dump ]]; then pass "BACKUP_KEEP_DAYS=3 deletes a 5-day-old dump"; else fail "BACKUP_KEEP_DAYS"; fi
if BACKUP_KEEP_DAYS=0 db >"$tmp/out" 2>&1; then fail "BACKUP_KEEP_DAYS=0 is refused"; else pass "BACKUP_KEEP_DAYS=0 is refused"; fi
n=$(find "$bk/control-db" -type f | wc -l)
if db --pg-dump pg_dump_fail >"$tmp/out" 2>&1; then fail "a failing pg_dump fails the backup"
elif [[ $(find "$bk/control-db" -type f | wc -l) == "$n" ]]; then pass "a failing pg_dump fails the backup and keeps no partial file"
else fail "a failing pg_dump left a file"; fi

# 2. The tenant files: a WAL-mode database with committed pages in the WAL and
# an open, uncommitted transaction; a staging database; secrets.json.
data=$tmp/data
mkdir -p "$data/t1" "$data/t2"
cat > "$tmp/holder.py" <<'PY'
import sqlite3, sys, time
path, ready = sys.argv[1], sys.argv[2]
c = sqlite3.connect(path, isolation_level=None)
c.execute("pragma journal_mode=wal")
c.execute("pragma wal_autocheckpoint=0")
c.execute("create table t (id integer primary key, v text)")
for i in range(200):
    c.execute("insert into t (v) values (?)", ("committed-%d" % i,))
c.execute("begin")
for i in range(200):
    c.execute("insert into t (v) values (?)", ("uncommitted-%d" % i,))
open(ready, "w").write("1")
time.sleep(120)
PY
python3 "$tmp/holder.py" "$data/t1/app.db" "$tmp/ready" &
holder_pid=$!
for _ in $(seq 100); do [[ -e $tmp/ready ]] && break; sleep 0.1; done
[[ -e $tmp/ready ]] || fail "the writer with an open transaction started"
sqlite3 "$data/t2/app.db" "pragma journal_mode=wal; create table t (id integer primary key); insert into t default values;" >/dev/null
sqlite3 "$data/t1/staging.db" "create table s (id integer); insert into s values (1);"
printf '{"secret":"do-not-copy"}' > "$data/t1/secrets.json"

tn() { "$here/backup-tenant-files.sh" --data-dir "$data" --backup-dir "$bk"; }
mkdir -m 0700 "$bk/tenants" "$bk/tenants/t1"
touch -d '30 days ago' "$bk/tenants/t1/app-20000101T000000Z.db"
if tn >"$tmp/out" 2>&1; then pass "the tenant snapshot runs"; else fail "tenant snapshot: $(cat "$tmp/out")"; fi
c1=$(find "$bk/tenants/t1" -name 'app-*Z.db' -newermt '1 minute ago')
if [[ -n $c1 && $(sqlite3 "$c1" 'pragma quick_check') == ok ]]; then pass "the copy of a WAL file with a writer mid-transaction passes quick_check"; else fail "quick_check of '$c1'"; fi
if [[ -n $c1 && $(sqlite3 "$c1" "select count(*) from t where v like 'committed-%'") == 200 && $(sqlite3 "$c1" "select count(*) from t where v like 'uncommitted-%'") == 0 ]]; then pass "the copy holds the 200 committed rows from the WAL and none of the uncommitted ones"; else fail "rows in the copy"; fi
if [[ $(find "$bk/tenants/t1" "$bk/tenants/t2" -name '*-*Z.db' -newermt '1 minute ago' | wc -l) == 3 ]]; then pass "app.db of two tenants and the staging database are copied"; else fail "copy count"; fi
if [[ -z $(find "$bk/tenants" -type f ! -perm 0600) && $(stat -c %a "$bk/tenants/t1" "$bk/tenants/t2" "$bk/tenants" "$bk" | sort -u) == 700 ]]; then pass "copies are 0600 in 0700 directories"; else fail "modes"; fi
if [[ ! -e $bk/tenants/t1/app-20000101T000000Z.db ]]; then pass "a copy older than 14 days is pruned"; else fail "tenant retention"; fi
if ! grep -rq "do-not-copy" "$bk/tenants" && [[ -z $(find "$bk/tenants" -name '*secrets*') ]]; then pass "secrets.json is not copied"; else fail "secrets.json copied"; fi
if grep -q "backup-tenant-files: t1 ->" "$tmp/out" && grep -q "backup-tenant-files: 3 copies of 2 tenants, 0 failed" "$tmp/out"; then pass "one log line per tenant and a final count"; else fail "log lines: $(cat "$tmp/out")"; fi
printf 'not a database, long enough to be read as one: %0200d' 0 > "$data/t2/broken.db"
if tn >"$tmp/out" 2>&1; then fail "a corrupt tenant file fails the run"; elif grep -q "t2/broken.db FAILED" "$tmp/out" && grep -q "backup-tenant-files: t1 ->" "$tmp/out"; then pass "a corrupt tenant file fails the run after the other tenants were copied"; else fail "corrupt tenant: $(cat "$tmp/out")"; fi
kill "$holder_pid" 2>/dev/null; holder_pid=""

# 3. restore-check.sh: a corrupt dump exits 1 before any database is touched.
if ! command -v pg_restore >/dev/null 2>&1; then
  echo "SKIP restore-check cases: pg_restore is not installed"
else
  rc=$tmp/rc
  mkdir -p "$rc/control-db" "$rc/tenants/t1"
  head -c 4096 /dev/urandom > "$rc/control-db/control-db-20990101T000000Z.dump"
  cp "$c1" "$rc/tenants/t1/app-20990101T000000Z.db"
  if "$here/restore-check.sh" --backup-dir "$rc" >"$tmp/out" 2>&1; then fail "restore-check.sh exits 1 on a corrupt dump"
  elif grep -q "not a readable pg_dump archive" "$tmp/out"; then pass "restore-check.sh exits 1 on a corrupt dump, before any database is touched"
  else fail "corrupt dump: $(cat "$tmp/out")"; fi
  mkdir -p "$tmp/empty"
  if "$here/restore-check.sh" --backup-dir "$tmp/empty" >"$tmp/out" 2>&1; then fail "restore-check.sh exits 1 with no backup"; else pass "restore-check.sh exits 1 when there is no control dump"; fi
fi

if [[ $failures -ne 0 ]]; then echo "$failures failed" >&2; exit 1; fi
echo "all passed"
