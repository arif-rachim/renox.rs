#!/usr/bin/env bash
# Weekly local snapshot of every tenant's SQLite file (#517, #516: R2 is off, so
# the single host keeps its own copies; ops/single-host.md "Local backups").
#
#   ops/scripts/backup-tenant-files.sh [--data-dir /var/lib/renox/data] [--backup-dir /var/backups/renox]
#
# For each <data-dir>/<tenant>/<name>.db (app.db, and <app>.db of staging
# databases) `sqlite3 .backup` writes a consistent copy, WAL included, to
# <backup-dir>/tenants/<tenant>/<name>-<yyyymmddThhmmssZ>.db (0600). Copies
# older than BACKUP_KEEP_DAYS (14) are then deleted. One log line per tenant
# and a final count; a tenant that fails does not stop the others, and the
# run exits 1 if any did. Only *.db files are read: never secrets.json.
# A disk failure is not covered until R2 is enabled.
#
# Options:
#   --data-dir <d>    the tenants' directory (/var/lib/renox/data)
#   --backup-dir <d>  root of the copies (/var/backups/renox)
#   --sqlite3 <cmd>   the sqlite3 binary (sqlite3 on PATH)
set -euo pipefail

data_dir=/var/lib/renox/data
backup_dir=/var/backups/renox
sqlite_bin=sqlite3

die() { echo "backup-tenant-files: $*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --data-dir) need_value "$@"; data_dir=$2; shift 2 ;;
    --backup-dir) need_value "$@"; backup_dir=$2; shift 2 ;;
    --sqlite3) need_value "$@"; sqlite_bin=$2; shift 2 ;;
    -h | --help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

keep_days=${BACKUP_KEEP_DAYS:-14}
[[ $keep_days =~ ^[1-9][0-9]{0,4}$ ]] || die "BACKUP_KEEP_DAYS must be a number of days (1 or more)"
[[ $data_dir == /* && $backup_dir == /* ]] || die "--data-dir and --backup-dir must be absolute paths"
[[ -d $data_dir ]] || die "$data_dir is not a directory"
command -v "$sqlite_bin" >/dev/null 2>&1 || die "$sqlite_bin is not installed (apt-get install sqlite3)"

umask 077
mkdir -p "$backup_dir" "$backup_dir/tenants"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name_re='^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'

tenants=0 copies=0 failed=0
for tdir in "$data_dir"/*/; do
  [[ -d $tdir && ! -L ${tdir%/} ]] || continue
  tenant=$(basename "$tdir")
  [[ $tenant =~ $name_re ]] || { echo "backup-tenant-files: skipped $tenant (unusual name)" >&2; continue; }
  dest=$backup_dir/tenants/$tenant
  n=0
  for db in "$tdir"*.db; do
    [[ -f $db && ! -L $db ]] || continue
    base=$(basename "$db" .db)
    [[ $base =~ $name_re ]] || { echo "backup-tenant-files: skipped $tenant/$base (unusual name)" >&2; continue; }
    mkdir -p "$dest"
    out=$dest/$base-$stamp.db
    partial=$dest/.$base-$stamp.partial
    rm -f "$partial"
    # The paths hold only [A-Za-z0-9_./-]: safe inside the single quotes.
    if [[ $db != *"'"* && $partial != *"'"* ]] \
      && "$sqlite_bin" -cmd ".timeout 10000" "$db" ".backup '$partial'" && [[ -s $partial ]]; then
      chmod 0600 "$partial"
      mv "$partial" "$out"
      n=$((n + 1))
    else
      rm -f "$partial"
      echo "backup-tenant-files: $tenant/$base.db FAILED" >&2
      failed=$((failed + 1))
    fi
  done
  if [[ $n -gt 0 ]]; then
    echo "backup-tenant-files: $tenant -> $dest ($n file(s))"
    tenants=$((tenants + 1))
    copies=$((copies + n))
  fi
done

find "$backup_dir/tenants" -mindepth 2 -maxdepth 2 -type f -name '*-[0-9]*T[0-9]*Z.db' -mtime "+$keep_days" -delete

echo "backup-tenant-files: $copies copies of $tenants tenants, $failed failed (kept $keep_days days)"
[[ $failed -eq 0 ]] || exit 1
