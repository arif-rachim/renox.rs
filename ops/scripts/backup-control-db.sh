#!/usr/bin/env bash
# Nightly backup of the control database to Cloudflare R2 (#366,
# ops/single-host.md "Backups"): `pg_dump` in the custom format, encrypted
# with age to a public key whose private half is kept off the host, uploaded
# with an S3 PUT signed by curl (AWS Signature Version 4, region `auto`).
#
#   ops/scripts/backup-control-db.sh --database renox \
#     --recipients /etc/renox/backup-age.pub --r2-env /etc/renox/secrets/r2-backup.env
#
# The R2 file (root-only, passed by renox-backup-db.service through
# LoadCredential) holds four lines, read without being sourced. It must be
# 0600 or 0400, or a systemd credential (root, 0440, in $CREDENTIALS_DIRECTORY):
#   R2_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
#   R2_BUCKET=renoxium-backups
#   R2_ACCESS_KEY_ID=…
#   R2_SECRET_ACCESS_KEY=…
# The key pair is an R2 API token with Object Read & Write on that bucket only.
# The secret reaches curl on its standard input (`--config -`), never its
# command line, and this script never prints it.
#
# Object key: <prefix>/<yyyy>/<mm>/control-db-<yyyymmddThhmmssZ>.dump.age.
# Retention is the bucket's, two owner steps (ops/single-host.md "Backups"):
# a lifecycle rule deletes objects under <prefix>/ after 30 days, and a bucket
# lock rule on <prefix>/ keeps every object for 30 days, so the host's key
# (which R2 cannot limit to writes only) cannot erase earlier backups either.
#
# Local mode, the default while R2 is off (#517, #516): with no R2_ENDPOINT in
# the environment or in the --r2-env file (or BACKUP_TARGET=local), the dump is
# written, unencrypted, to <backup-dir>/control-db/control-db-<stamp>.dump
# (0600) and files there older than BACKUP_KEEP_DAYS (14) are deleted. The
# disk is the only copy: a disk failure is not covered until R2 is enabled.
# BACKUP_TARGET=r2 forces the R2 mode above.
#
# Options:
#   --backup-dir <d> local mode: the root of the copies (/var/backups/renox)
#   --pg-user <u>    run pg_dump as this user when started as root (postgres)
#   --prefix <p>     object key prefix (control-db)
#   --work-dir <d>   where the encrypted dump is staged (a fresh 0700 temp dir)
#   --pg-dump <cmd>  the pg_dump binary (pg_dump on PATH)
set -euo pipefail

database=""
recipients=""
r2_env=""
prefix=control-db
work_parent=${TMPDIR:-/tmp}
pg_dump_bin=pg_dump
backup_dir=/var/backups/renox
pg_user=""

die() { echo "backup-control-db: $*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --database) need_value "$@"; database=$2; shift 2 ;;
    --recipients) need_value "$@"; recipients=$2; shift 2 ;;
    --r2-env) need_value "$@"; r2_env=$2; shift 2 ;;
    --prefix) need_value "$@"; prefix=$2; shift 2 ;;
    --work-dir) need_value "$@"; work_parent=$2; shift 2 ;;
    --backup-dir) need_value "$@"; backup_dir=$2; shift 2 ;;
    --pg-user) need_value "$@"; pg_user=$2; shift 2 ;;
    --pg-dump) need_value "$@"; pg_dump_bin=$2; shift 2 ;;
    -h | --help) sed -n '2,42p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

[[ $database =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$ ]] || die "--database must name the control database"
[[ $prefix =~ ^[a-z0-9][a-z0-9/_-]{0,62}$ && $prefix != */ ]] || die "--prefix must be like control-db"
# pg_dump, as the database's own user when this runs as root (peer authentication).
run_pg_dump() {
  if [[ -n $pg_user && $(id -u) -eq 0 ]]; then
    setpriv --reuid="$pg_user" --regid="$pg_user" --init-groups "$pg_dump_bin" "$@"
  else
    "$pg_dump_bin" "$@"
  fi
}

target=${BACKUP_TARGET:-}
if [[ -z $target ]]; then
  if [[ -n ${R2_ENDPOINT:-} ]] || { [[ -n $r2_env && -r $r2_env ]] && grep -q '^R2_ENDPOINT=.' "$r2_env"; }; then target=r2; else target=local; fi
fi
[[ $target == local || $target == r2 ]] || die "BACKUP_TARGET must be local or r2"

if [[ $target == local ]]; then
  keep_days=${BACKUP_KEEP_DAYS:-14}
  [[ $keep_days =~ ^[1-9][0-9]{0,4}$ ]] || die "BACKUP_KEEP_DAYS must be a number of days (1 or more)"
  [[ $backup_dir == /* ]] || die "--backup-dir must be an absolute path"
  command -v "$pg_dump_bin" >/dev/null 2>&1 || die "$pg_dump_bin is not installed (postgresql-client)"
  umask 077
  dest=$backup_dir/control-db
  mkdir -p "$backup_dir" "$dest"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file=$dest/control-db-$stamp.dump
  partial=$dest/.control-db-$stamp.partial
  trap 'rm -f "$partial"' EXIT
  run_pg_dump --format=custom --compress=6 --dbname="$database" > "$partial" || die "pg_dump failed; nothing was kept"
  [[ -s $partial ]] || die "the dump is empty"
  chmod 0600 "$partial"
  mv "$partial" "$file"
  find "$dest" -maxdepth 1 -type f -name 'control-db-*.dump' -mtime "+$keep_days" -delete
  echo "backup-control-db: $database -> $file ($(stat -c %s "$file") bytes)"
  exit 0
fi

[[ -f $recipients && -s $recipients ]] || die "--recipients must name the age public key file"
grep -Eq '^age1[0-9a-z]{58}$' "$recipients" || die "--recipients holds no age public key (age1…): never put the private key on the host"
if grep -q 'AGE-SECRET-KEY' "$recipients"; then die "--recipients holds a private key: keep it off the host"; fi
command -v age >/dev/null 2>&1 || die "age is not installed (apt-get install age)"
command -v "$pg_dump_bin" >/dev/null 2>&1 || die "$pg_dump_bin is not installed (postgresql-client)"

# The R2 credentials: owner-only file, four known keys, nothing executed.
# One exception (#395): systemd 255 hands a credential to a unit with
# User=postgres as root-owned 0440 (read for the unit's user through an ACL)
# in the unit's private $CREDENTIALS_DIRECTORY, which no other unit or user
# can see. Group read is accepted there and only there: the file sits
# directly in that directory, belongs to root, and has no write or other bit.
[[ -n $r2_env && -f $r2_env ]] || die "--r2-env must name the R2 credentials file"
mode=$(stat -L -c %a "$r2_env")
systemd_credential() {
  [[ -n ${CREDENTIALS_DIRECTORY:-} && -d $CREDENTIALS_DIRECTORY ]] || return 1
  [[ $mode =~ ^[0-7]?[04][04]0$ ]] || return 1
  [[ $(stat -L -c %u "$r2_env") == 0 ]] || return 1
  [[ $(dirname "$(realpath -e "$r2_env")") == "$(realpath -e "$CREDENTIALS_DIRECTORY")" ]]
}
if [[ ! $mode =~ ^[0-7]?[0-7]00$ ]] && ! systemd_credential; then
  die "the R2 credentials file is readable by group or others (mode $mode): chmod 0600 it, or pass it through LoadCredential"
fi
endpoint="" bucket="" key_id="" secret=""
while IFS= read -r line || [[ -n $line ]]; do
  [[ -z $line || $line == \#* ]] && continue
  name=${line%%=*}
  value=${line#*=}
  case $name in
    R2_ENDPOINT) endpoint=$value ;;
    R2_BUCKET) bucket=$value ;;
    R2_ACCESS_KEY_ID) key_id=$value ;;
    R2_SECRET_ACCESS_KEY) secret=$value ;;
    *) die "the R2 credentials file has an unknown key ($name)" ;;
  esac
done < "$r2_env"
[[ $endpoint =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ || ${RENOX_BACKUP_ALLOW_HTTP:-} == 1 && $endpoint =~ ^http://127\.0\.0\.1:[0-9]+$ ]] \
  || die "R2_ENDPOINT must be https://<account id>.r2.cloudflarestorage.com"
[[ $bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "R2_BUCKET is not a bucket name"
[[ $key_id =~ ^[A-Za-z0-9]{16,128}$ ]] || die "R2_ACCESS_KEY_ID is missing or malformed"
[[ -n $secret && $secret != *[[:space:]\"\\]* ]] || die "R2_SECRET_ACCESS_KEY is missing or malformed"

umask 077
work=$(mktemp -d "$work_parent/control-db-backup.XXXXXX")
trap 'rm -rf "$work"' EXIT

stamp=$(date -u +%Y%m%dT%H%M%SZ)
object=$prefix/${stamp:0:4}/${stamp:4:2}/control-db-$stamp.dump.age
file=$work/backup.dump.age

started=$(date +%s)
# pipefail: a failing pg_dump fails the backup even though age succeeded.
run_pg_dump --format=custom --compress=6 --dbname="$database" | age --encrypt --recipients-file "$recipients" --output "$file"
[[ -s $file ]] || die "the encrypted dump is empty"
size=$(stat -c %s "$file")
sum=$(sha256sum "$file" | awk '{ print $1 }')

# The secret goes to curl on stdin as its config, so it is never in argv.
upload() {
  printf 'user = "%s:%s"\n' "$key_id" "$secret" | curl --config - --fail --silent --show-error \
    --proto '=https,http' --retry 4 --retry-delay 2 --retry-all-errors \
    --aws-sigv4 "aws:amz:auto:s3" "$@"
}
upload --upload-file "$file" --header "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
  --header "x-amz-meta-sha256: $sum" --output /dev/null "$endpoint/$bucket/$object" \
  || die "the upload of $object failed"

# Read back: the object exists with the size that was sent.
remote=$(upload --head --header "x-amz-content-sha256: UNSIGNED-PAYLOAD" "$endpoint/$bucket/$object" | tr -d '\r' | awk -F': ' 'tolower($1) == "content-length" { print $2 }')
[[ $remote == "$size" ]] || die "$object: the stored size (${remote:-none}) is not the uploaded size ($size)"

echo "backup-control-db: $database -> $bucket/$object ($size bytes, sha256 $sum, $(( $(date +%s) - started )) s)"
