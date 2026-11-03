#!/usr/bin/env bash
# The wildcard certificate of the tenant app domain (#366, ops/single-host.md):
# `*.renoxium.app` and `renoxium.app` in one certificate, from Let's Encrypt
# by DNS-01 with lego's Cloudflare provider, installed where the worker's
# CertStore loads it, then a running worker is told to reload (SIGHUP through
# `systemctl reload renox-worker`, crates/renox-cell/src/worker.rs).
#
#   ops/scripts/renew-wildcard-cert.sh --domain renoxium.app --email ops@renoxium.com \
#     --token-file /etc/renox/secrets/cloudflare-dns.token
#
# The token is a Cloudflare API token limited to Zone:DNS:Edit on the one
# zone. It is read by lego from the file (CLOUDFLARE_DNS_API_TOKEN_FILE), never
# from the environment or the command line, and this script never prints it.
# A token file that another user can read is refused. renox-cert-renew.service
# passes it through systemd's LoadCredential, so the file stays root-only.
#
# Options (defaults are the single host's):
#   --cert-dir <dir>     the worker's [tls] cert_dir (/var/lib/renox/data/_certs)
#   --lego-path <dir>    lego's account and certificate store (/var/lib/renox-acme)
#   --lego-bin <file>    /opt/renox/bin/lego (ops/scripts/fetch-lego.sh)
#   --days <n>           renew when fewer than n days are left (30)
#   --staging            Let's Encrypt's staging directory (a dry run of the setup)
#   --owner <user:group> owner of the installed files (renox:renox)
#   --reload-cmd <cmd>   run after a new certificate was installed, instead of
#                        the default: `systemctl reload renox-worker.service`
#                        when that unit is active, nothing when it is not (the
#                        worker loads cert_dir when it starts, so the first
#                        install, before the worker runs, succeeds: #399)
#
# Writes into the format of crates/renox-gateway/src/tls.rs:
#   <cert_dir>/_wildcard.<domain>/{fullchain,privkey}.pem   for *.<domain>
#   <cert_dir>/<domain>/{fullchain,privkey}.pem             for the apex
# A certificate that does not name both, or whose key does not match, is
# refused and the installed one is left as it was. Nothing is reloaded when
# the certificate did not change.
set -euo pipefail

domain=""
email=""
token_file=""
cert_dir=/var/lib/renox/data/_certs
lego_path=/var/lib/renox-acme
lego_bin=/opt/renox/bin/lego
days=30
staging=0
owner=renox:renox
reload_cmd=""
worker_unit=renox-worker.service

die() { echo "renew-wildcard-cert: $*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) need_value "$@"; domain=$2; shift 2 ;;
    --email) need_value "$@"; email=$2; shift 2 ;;
    --token-file) need_value "$@"; token_file=$2; shift 2 ;;
    --cert-dir) need_value "$@"; cert_dir=$2; shift 2 ;;
    --lego-path) need_value "$@"; lego_path=$2; shift 2 ;;
    --lego-bin) need_value "$@"; lego_bin=$2; shift 2 ;;
    --days) need_value "$@"; days=$2; shift 2 ;;
    --staging) staging=1; shift ;;
    --owner) need_value "$@"; owner=$2; shift 2 ;;
    --reload-cmd) need_value "$@"; reload_cmd=$2; shift 2 ;;
    -h | --help) sed -n '2,35p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

[[ $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "--domain must be a lower-case domain like renoxium.app"
[[ $email =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]] || die "--email must be the ACME account's address"
[[ $days =~ ^[0-9]{1,2}$ && $days -ge 1 && $days -le 60 ]] || die "--days must be 1 to 60"
[[ -x $lego_bin ]] || die "$lego_bin is not executable (ops/scripts/fetch-lego.sh)"
command -v openssl >/dev/null 2>&1 || die "openssl is needed to check the certificate"

# The token file: present, not empty, readable by its owner only.
[[ -n $token_file ]] || die "--token-file is required"
[[ -f $token_file && ! -L $token_file ]] || die "--token-file must name a regular file"
[[ -s $token_file ]] || die "the token file is empty"
mode=$(stat -L -c %a "$token_file")
[[ $mode =~ ^[0-7]?[0-7]00$ ]] || die "the token file is readable by group or others (mode $mode): chmod 0600 it"

wildcard="*.$domain"
# lego names the files after the first domain, '*' replaced by '_'.
stem=_.$domain

install -d -m 0700 "$lego_path"
args=(--accept-tos --email "$email" --dns cloudflare --domains "$wildcard" --domains "$domain"
  --key-type ec256 --path "$lego_path")
if [[ $staging -eq 1 ]]; then args+=(--server https://acme-staging-v02.api.letsencrypt.org/directory); fi

# lego reads the token from the file; the variable holding the value itself
# is cleared so an inherited one cannot be used instead.
export CLOUDFLARE_DNS_API_TOKEN_FILE=$token_file
unset CLOUDFLARE_DNS_API_TOKEN CF_DNS_API_TOKEN CF_API_KEY CF_API_EMAIL CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL

if [[ -f $lego_path/certificates/$stem.crt ]]; then
  "$lego_bin" "${args[@]}" renew --days "$days"
else
  "$lego_bin" "${args[@]}" run
fi

crt=$lego_path/certificates/$stem.crt
key=$lego_path/certificates/$stem.key
[[ -f $crt && -f $key ]] || die "lego wrote no $stem.crt and $stem.key under $lego_path/certificates"

# The certificate must name both, and the key must be its key.
sans=$(openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null || true)
grep -qF "DNS:$wildcard" <<< "$sans" || die "the certificate does not name $wildcard; nothing installed"
grep -Eq "DNS:${domain//./\\.}(,|$)" <<< "$sans" || die "the certificate does not name $domain; nothing installed"
cert_pub=$(openssl x509 -in "$crt" -noout -pubkey | openssl sha256)
key_pub=$(openssl pkey -in "$key" -pubout 2>/dev/null | openssl sha256)
[[ $cert_pub == "$key_pub" ]] || die "the private key does not match the certificate; nothing installed"
openssl x509 -in "$crt" -noout -checkend 0 >/dev/null || die "the certificate has expired; nothing installed"

changed=0
install_into() {
  local dir=$1
  install -d -m 0750 -o "${owner%%:*}" -g "${owner##*:}" "$dir"
  if cmp -s "$crt" "$dir/fullchain.pem" && cmp -s "$key" "$dir/privkey.pem"; then return; fi
  # New files next to the old ones, then renamed over them.
  install -m 0640 -o "${owner%%:*}" -g "${owner##*:}" "$key" "$dir/.privkey.pem.new"
  install -m 0644 -o "${owner%%:*}" -g "${owner##*:}" "$crt" "$dir/.fullchain.pem.new"
  mv -f "$dir/.privkey.pem.new" "$dir/privkey.pem"
  mv -f "$dir/.fullchain.pem.new" "$dir/fullchain.pem"
  changed=1
}
install_into "$cert_dir/_wildcard.$domain"
install_into "$cert_dir/$domain"

expiry=$(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2)
if [[ $changed -eq 1 ]]; then
  # The files are in place: say so first, so the journal records the install
  # even when the reload that follows fails (#399).
  echo "renew-wildcard-cert: installed a new certificate for $wildcard and $domain (expires $expiry)"
  if [[ -n $reload_cmd ]]; then
    # The operator's own command, split on spaces.
    read -r -a reload <<< "$reload_cmd"
    "${reload[@]}" || die "the certificate is installed, but the reload command failed: $reload_cmd"
    echo "renew-wildcard-cert: worker reloaded ($reload_cmd)"
  elif systemctl is-active --quiet "$worker_unit"; then
    systemctl reload "$worker_unit" || die "the certificate is installed, but systemctl reload $worker_unit failed"
    echo "renew-wildcard-cert: worker reloaded"
  else
    echo "renew-wildcard-cert: $worker_unit is not active; nothing reloaded, the worker loads the certificate when it starts"
  fi
else
  echo "renew-wildcard-cert: certificate for $wildcard and $domain unchanged (expires $expiry)"
fi
