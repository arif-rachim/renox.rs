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
# LoadCredential) holds four lines, read without being sourced:
#   R2_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
#   R2_BUCKET=renoxium-backups
#   R2_ACCESS_KEY_ID=…
#   R2_SECRET_ACCESS_KEY=…
# The key pair is an R2 API token with Object Read & Write on that bucket only.
# The secret reaches curl on its standard input (`--config -`), never its
# command line, and this script never prints it.
#
# Object key: <prefix>/<yyyy>/<mm>/control-db-<yyyymmddThhmmssZ>.dump.age.
# Retention (30 days) is the bucket's lifecycle rule on <prefix>/, an owner
# step: the host's key cannot delete old backups, so a compromised host cannot
# erase them either.
#
# Options:
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

die() { echo "backup-control-db: $*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --database) need_value "$@"; database=$2; shift 2 ;;
    --recipients) need_value "$@"; recipients=$2; shift 2 ;;
    --r2-env) need_value "$@"; r2_env=$2; shift 2 ;;
    --prefix) need_value "$@"; prefix=$2; shift 2 ;;
    --work-dir) need_value "$@"; work_parent=$2; shift 2 ;;
    --pg-dump) need_value "$@"; pg_dump_bin=$2; shift 2 ;;
    -h | --help) sed -n '2,32p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

[[ $database =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$ ]] || die "--database must name the control database"
[[ $prefix =~ ^[a-z0-9][a-z0-9/_-]{0,62}$ && $prefix != */ ]] || die "--prefix must be like control-db"
[[ -f $recipients && -s $recipients ]] || die "--recipients must name the age public key file"
grep -Eq '^age1[0-9a-z]{58}$' "$recipients" || die "--recipients holds no age public key (age1…): never put the private key on the host"
if grep -q 'AGE-SECRET-KEY' "$recipients"; then die "--recipients holds a private key: keep it off the host"; fi
command -v age >/dev/null 2>&1 || die "age is not installed (apt-get install age)"
command -v "$pg_dump_bin" >/dev/null 2>&1 || die "$pg_dump_bin is not installed (postgresql-client)"

# The R2 credentials: owner-only file, four known keys, nothing executed.
[[ -n $r2_env && -f $r2_env ]] || die "--r2-env must name the R2 credentials file"
mode=$(stat -L -c %a "$r2_env")
[[ $mode =~ ^[0-7]?[0-7]00$ ]] || die "the R2 credentials file is readable by group or others (mode $mode): chmod 0600 it"
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
"$pg_dump_bin" --format=custom --compress=6 --dbname="$database" | age --encrypt --recipients-file "$recipients" --output "$file"
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
