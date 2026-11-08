#!/usr/bin/env bash
# Tests of restore-check.sh's step selection (#538). The Postgres tools are
# stubs on PATH (backup-local.test.sh restores a real dump); the tenant copy
# is a real SQLite file. No network, no database. Cases: --tenants-only;
# --control-only; an R2 host with no local dump (the control step skipped
# with its line, exit 0 on the tenant step); no dump and no R2 (exit 1);
# --control-only on an R2 host (exit 1); both flags (refused). The R2
# endpoint's value is never printed. Threat-model row (docs/24-threat-model.md):
# "Secrets in logs, errors, bundle, responses".
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
check=$here/restore-check.sh
command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP restore-check test: sqlite3 is not installed"; exit 0; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

mkdir -p "$tmp/bin"
# shellcheck disable=SC2016 # the stubs expand $* and $PG_LOG when they run
for tool in createdb dropdb; do printf '#!/bin/sh\necho "%s $*" >> "$PG_LOG"\n' "$tool" > "$tmp/bin/$tool"; done
cat > "$tmp/bin/pg_restore" <<'STUB'
#!/bin/sh
echo "pg_restore $*" >> "$PG_LOG"
grep -q '^PGDMP' || exit 1
STUB
# shellcheck disable=SC2016
printf '#!/bin/sh\necho "psql $*" >> "$PG_LOG"\necho 3\n' > "$tmp/bin/psql"
chmod +x "$tmp/bin"/*
export PATH="$tmp/bin:$PATH" PG_LOG="$tmp/pg.log"

# A tenant copy, a control dump (stub format), and an R2 settings file.
tenants_dir() { mkdir -p "$1/tenants/acme" && sqlite3 "$1/tenants/acme/app-20261101T031700Z.db" 'create table t(x); insert into t values (1);'; }
control_dir() { mkdir -p "$1/control-db" && printf 'PGDMP fake\n' > "$1/control-db/control-db-20261101T021700Z.dump"; }
endpoint="https://0123456789abcdef.r2.cloudflarestorage.com"
printf 'R2_ENDPOINT=%s\nR2_BUCKET=renoxium-backups\n' "$endpoint" > "$tmp/r2.env"
printf 'R2_BUCKET=renoxium-backups\n' > "$tmp/r2-off.env"
run() { "$check" --r2-env "${R2_ENV:-$tmp/none.env}" "$@" >"$tmp/out" 2>&1; }

# 1. --tenants-only: no control dump needed, no Postgres tool run.
tenants_dir "$tmp/t1"
rm -f "$PG_LOG"
if run --backup-dir "$tmp/t1" --tenants-only && grep -q "app-20261101T031700Z.db quick_check ok" "$tmp/out" && [[ ! -e $PG_LOG ]]; then
  pass "--tenants-only checks the newest tenant copy, names it, and runs no Postgres tool"
else fail "--tenants-only: $(cat "$tmp/out")"; fi

# 2. --control-only: the dump restored and counted; no tenant copy needed.
control_dir "$tmp/t2"
if run --backup-dir "$tmp/t2" --control-only && grep -q "control-db-20261101T021700Z.dump restored, 3 tenants" "$tmp/out" && ! grep -q quick_check "$tmp/out" \
  && grep -q "^dropdb renox_restore_check$" "$PG_LOG"; then
  pass "--control-only restores the dump into the scratch database and drops it, without a tenant copy"
else fail "--control-only: $(cat "$tmp/out")"; fi

# 3. An R2 host without a local dump: the control step is skipped, the tenant step passes.
tenants_dir "$tmp/t3"
if R2_ENV=$tmp/r2.env run --backup-dir "$tmp/t3" && grep -q "^restore-check: control dump is in R2; run the Restore drill from the workstation$" "$tmp/out" \
  && grep -q "quick_check ok" "$tmp/out"; then
  pass "an R2 host with no local dump: the control step is skipped with its line, exit 0 on the tenant copy"
else fail "R2 host, no local dump: $(cat "$tmp/out")"; fi
if grep -q -- "$endpoint" "$tmp/out"; then fail "the R2 endpoint was printed"; else pass "the R2 endpoint's value is not printed"; fi
# ... and its tenant step still decides: no tenant copy fails.
mkdir -p "$tmp/t3b"
if R2_ENV=$tmp/r2.env run --backup-dir "$tmp/t3b"; then fail "an R2 host without a tenant copy fails"
elif grep -q "no tenant copy" "$tmp/out"; then pass "an R2 host without a tenant copy still fails"
else fail "R2 host, no tenant copy: $(cat "$tmp/out")"; fi

# 4. No local dump and no R2 (no file, or a file without R2_ENDPOINT): exit 1.
tenants_dir "$tmp/t4"
if run --backup-dir "$tmp/t4"; then fail "no dump and no R2 fails"
elif grep -q "no control dump under $tmp/t4/control-db" "$tmp/out"; then pass "no dump and no R2 configuration: exit 1"
else fail "no dump, no R2: $(cat "$tmp/out")"; fi
if R2_ENV=$tmp/r2-off.env run --backup-dir "$tmp/t4"; then fail "an R2 file without R2_ENDPOINT counts as no R2"
else pass "an R2 file without R2_ENDPOINT counts as no R2"; fi

# 5. --control-only on an R2 host with no local dump: exit 1, pointing at the drill.
if R2_ENV=$tmp/r2.env run --backup-dir "$tmp/t3" --control-only; then fail "--control-only on an R2 host fails"
elif grep -q "it is in R2; run the Restore drill from the workstation" "$tmp/out"; then pass "--control-only on an R2 host with no local dump: exit 1, the drill named"
else fail "--control-only on R2: $(cat "$tmp/out")"; fi

# 6. Both flags: refused.
if run --backup-dir "$tmp/t1" --tenants-only --control-only; then fail "both flags are refused"
elif grep -q "exclude each other" "$tmp/out"; then pass "--tenants-only with --control-only is refused"
else fail "both flags: $(cat "$tmp/out")"; fi

# 7. Both steps, the default on a local-backup host.
tenants_dir "$tmp/t2"
if run --backup-dir "$tmp/t2" && grep -q "restored, 3 tenants" "$tmp/out" && grep -q "quick_check ok" "$tmp/out"; then pass "without flags both steps run"
else fail "both steps: $(cat "$tmp/out")"; fi

echo
if [[ $failures -eq 0 ]]; then echo "all passed"; else echo "$failures failed"; exit 1; fi
