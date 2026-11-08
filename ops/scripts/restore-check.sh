#!/usr/bin/env bash
# Monthly restore drill of the local backups (#517, #516; ops/single-host.md
# "Local backups (no R2)"). Proves the newest copies are usable; run it on the
# host after both backup services, as root:
#
#   ops/scripts/restore-check.sh [--backup-dir /var/backups/renox] [--pg-user postgres]
#                                [--tenants-only | --control-only] [--r2-env <file>]
#
# 1. The newest control dump: `pg_restore --list` (a corrupt file fails here,
#    before any database is touched), then `createdb renox_restore_check`,
#    `pg_restore --no-owner --exit-on-error`, `select count(*) from tenants`,
#    and `dropdb` (also on failure).
# 2. The newest tenant copy opens with `sqlite3 'pragma quick_check'` = ok.
# Exit 0 only if every step that runs passes; any failure exits 1 with the
# reason on stderr.
#
# On a host whose control dumps go to R2 (#538: R2_ENDPOINT in the R2 env
# file, as on node-small) there is no local dump, and the dump is
# age-encrypted to a key the host does not hold. Without a flag, step 1 is
# then skipped with a line saying so ("Restore drill" from the workstation
# covers it) and step 2 decides the exit code. No local dump and no R2
# configuration is still a failure.
#
# Options:
#   --backup-dir <d>  root of the copies (/var/backups/renox)
#   --pg-user <u>     run the Postgres tools as this user when started as root
#   --scratch <name>  the scratch database (renox_restore_check)
#   --tenants-only    step 2 only
#   --control-only    step 1 only (fails without a local dump, R2 or not)
#   --r2-env <file>   the backup's R2 settings (/etc/renox/secrets/r2-backup.env);
#                     only whether it sets R2_ENDPOINT is read, never printed
set -euo pipefail

backup_dir=/var/backups/renox
pg_user=""
scratch=renox_restore_check
tenants_only=0
control_only=0
r2_env=/etc/renox/secrets/r2-backup.env

die() { echo "restore-check: $*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --backup-dir) need_value "$@"; backup_dir=$2; shift 2 ;;
    --pg-user) need_value "$@"; pg_user=$2; shift 2 ;;
    --scratch) need_value "$@"; scratch=$2; shift 2 ;;
    --tenants-only) tenants_only=1; shift ;;
    --control-only) control_only=1; shift ;;
    --r2-env) need_value "$@"; r2_env=$2; shift 2 ;;
    -h | --help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

[[ $scratch =~ ^renox_restore_[a-z0-9_]{1,40}$ ]] || die "--scratch must be a name like renox_restore_check"
[[ $tenants_only -eq 1 && $control_only -eq 1 ]] && die "--tenants-only and --control-only exclude each other"
check_control=$((1 - tenants_only))
check_tenants=$((1 - control_only))

# 1a. Is there a local control dump to restore here?
dump=""
if [[ $check_control -eq 1 ]]; then
  dump=$(find "$backup_dir/control-db" -maxdepth 1 -type f -name 'control-db-*.dump' 2>/dev/null | sort | tail -n 1 || true)
  if [[ -z $dump ]]; then
    r2=0
    # The file is root-only; a test of the key's presence reads no value out.
    if [[ -r $r2_env ]] && grep -Eq '^R2_ENDPOINT=.+' "$r2_env"; then r2=1; fi
    if [[ $r2 -eq 1 && $control_only -eq 0 ]]; then
      echo "restore-check: control dump is in R2; run the Restore drill from the workstation"
      check_control=0
    elif [[ $r2 -eq 1 ]]; then
      die "no control dump under $backup_dir/control-db: it is in R2; run the Restore drill from the workstation"
    else
      die "no control dump under $backup_dir/control-db"
    fi
  fi
fi

tools=()
[[ $check_control -eq 1 ]] && tools+=(pg_restore createdb dropdb psql)
[[ $check_tenants -eq 1 ]] && tools+=(sqlite3)
for tool in "${tools[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed (postgresql-client, sqlite3)"
done

pg() {
  if [[ -n $pg_user && $(id -u) -eq 0 ]]; then
    setpriv --reuid="$pg_user" --regid="$pg_user" --init-groups "$@"
  else
    "$@"
  fi
}

# 1. The control dump.
created=0
cleanup() { [[ $created -eq 1 ]] && pg dropdb --if-exists "$scratch" >/dev/null 2>&1; return 0; }
trap cleanup EXIT
if [[ $check_control -eq 1 ]]; then
  # The dump is readable by root only; hand the postgres tools a copy of its content on stdin.
  pg_restore --list < "$dump" > /dev/null 2>&1 || die "$dump is not a readable pg_dump archive"
  pg createdb "$scratch" || die "createdb $scratch failed"
  created=1
  pg pg_restore --dbname "$scratch" --no-owner --exit-on-error < "$dump" || die "pg_restore of $dump failed"
  tenants=$(pg psql --dbname "$scratch" -Atc "select count(*) from tenants") || die "select count(*) from tenants failed"
  [[ $tenants =~ ^[0-9]+$ ]] || die "tenants count is not a number: $tenants"
  pg dropdb "$scratch" || die "dropdb $scratch failed"
  created=0
  echo "restore-check: $dump restored, $tenants tenants"
fi

# 2. The newest tenant copy.
if [[ $check_tenants -eq 1 ]]; then
  copy=$(find "$backup_dir/tenants" -mindepth 2 -maxdepth 2 -type f -name '*-[0-9]*T[0-9]*Z.db' -printf '%T@\t%p\n' 2>/dev/null | sort -n | tail -n 1 | cut -f2 || true)
  [[ -n $copy ]] || die "no tenant copy under $backup_dir/tenants"
  check=$(sqlite3 "$copy" 'pragma quick_check') || die "$copy cannot be opened"
  [[ $check == ok ]] || die "$copy: quick_check says: $check"
  echo "restore-check: $copy quick_check ok"
fi
