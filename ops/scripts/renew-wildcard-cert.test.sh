#!/usr/bin/env bash
# Tests of renew-wildcard-cert.sh (#366), run by CI's ops step with a fake
# lego that writes a self-signed certificate: no network, no ACME, no token.
# Proves: a token file readable by others is refused; the first run installs
# the certificate into both CertStore directories and reloads once; a second
# run with the same certificate does not reload; `renew` is used once a
# certificate exists; a certificate without the apex, or with another key, is
# refused and the installed one is kept; the token reaches lego only as a file
# path, and its value never appears on the command line or in the output;
# by default an active worker is reloaded, an inactive one is not and the run
# still succeeds, and the "installed" line comes before any reload (#399).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
renew=$here/renew-wildcard-cert.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
command -v openssl >/dev/null 2>&1 || { echo "SKIP renew-wildcard-cert test: no openssl"; exit 0; }

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

# A value that must never be printed or passed on a command line.
secret=test-not-a-real-token-$RANDOM$RANDOM
printf '%s\n' "$secret" > "$tmp/token"
chmod 0600 "$tmp/token"

# The fake lego: records its arguments and environment, writes a certificate
# for the names in $FAKE_SANS (default: both), with a fresh key unless
# $FAKE_OTHER_KEY is set.
cat > "$tmp/lego" <<'LEGO'
#!/usr/bin/env bash
set -euo pipefail
log=$FAKE_LOG
printf 'argv:' >> "$log"; printf ' %q' "$@" >> "$log"; printf '\n' >> "$log"
printf 'token_file=%s token_env=%s\n' "${CLOUDFLARE_DNS_API_TOKEN_FILE:-}" "${CLOUDFLARE_DNS_API_TOKEN:-}${CF_DNS_API_TOKEN:-}" >> "$log"
path=""; prev=""
for a in "$@"; do [[ $prev == --path ]] && path=$a; prev=$a; done
mkdir -p "$path/certificates"
crt=$path/certificates/_.renoxium.test.crt key=$path/certificates/_.renoxium.test.key
if [[ ${FAKE_KEEP:-0} == 1 && -f $crt ]]; then exit 0; fi
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 90 -subj "/CN=*.renoxium.test" \
  -addext "subjectAltName=${FAKE_SANS:-DNS:*.renoxium.test,DNS:renoxium.test}" -keyout "$key" -out "$crt" 2>/dev/null
if [[ -n ${FAKE_OTHER_KEY:-} ]]; then openssl genpkey -algorithm ec -pkeyopt ec_paramgen_curve:prime256v1 -out "$key" 2>/dev/null; fi
LEGO
chmod 0755 "$tmp/lego"

me=$(id -un):$(id -gn)
export FAKE_LOG=$tmp/lego.log
run() {
  "$renew" --domain renoxium.test --email ops@renoxium.test --token-file "$tmp/token" \
    --cert-dir "$tmp/certs" --lego-path "$tmp/acme" --lego-bin "$tmp/lego" --owner "$me" \
    --reload-cmd "touch $tmp/reloaded"
}
reloads() { if [[ -f $tmp/reloaded ]]; then echo 1; else echo 0; fi; }

# 1. A token file readable by the group: refused before lego runs.
chmod 0640 "$tmp/token"
if run >"$tmp/out" 2>&1; then fail "a group-readable token file is refused"
elif grep -q "readable by group or others" "$tmp/out" && [[ ! -e $FAKE_LOG ]]; then pass "a group-readable token file is refused before lego runs"
else fail "a group-readable token file is refused: $(cat "$tmp/out")"; fi
chmod 0600 "$tmp/token"

# 2. First run: lego `run`, both directories written, one reload.
if run >"$tmp/out" 2>&1 && [[ $(reloads) == 1 ]]; then pass "the first run installs the certificate and reloads the worker"
else fail "the first run: $(cat "$tmp/out")"; fi
for d in "_wildcard.renoxium.test" "renoxium.test"; do
  if [[ -f $tmp/certs/$d/fullchain.pem && -f $tmp/certs/$d/privkey.pem ]] && [[ $(stat -c %a "$tmp/certs/$d/privkey.pem") == 640 ]]; then
    pass "$d/fullchain.pem and privkey.pem (0640) are installed"
  else fail "$d/ is installed"; fi
done
if grep -q "argv:.* run$" "$FAKE_LOG"; then pass "lego 'run' on the first issue"; else fail "lego 'run' on the first issue: $(cat "$FAKE_LOG")"; fi
if grep -q -- "--dns cloudflare" "$FAKE_LOG" && grep -q -- "--domains \\\\\*.renoxium.test --domains renoxium.test" "$FAKE_LOG"; then
  pass "lego is asked for *.renoxium.test and renoxium.test by DNS-01 with Cloudflare"
else fail "lego's arguments: $(cat "$FAKE_LOG")"; fi

# 3. Second run, lego keeps the certificate: `renew`, no reload.
rm -f "$tmp/reloaded"
if FAKE_KEEP=1 run >"$tmp/out" 2>&1 && [[ $(reloads) == 0 ]] && grep -q unchanged "$tmp/out"; then pass "an unchanged certificate does not reload the worker"
else fail "an unchanged certificate: $(cat "$tmp/out")"; fi
if tail -n 2 "$FAKE_LOG" | grep -q "argv:.* renew --days 30$"; then pass "lego 'renew --days 30' once a certificate exists"; else fail "lego renew: $(tail -n 2 "$FAKE_LOG")"; fi

# 4. A certificate without the apex: refused, the installed one kept.
before=$(sha256sum "$tmp/certs/renoxium.test/fullchain.pem")
if FAKE_SANS="DNS:*.renoxium.test" run >"$tmp/out" 2>&1; then fail "a certificate without the apex is refused"
elif grep -q "does not name renoxium.test" "$tmp/out" && [[ $(sha256sum "$tmp/certs/renoxium.test/fullchain.pem") == "$before" && $(reloads) == 0 ]]; then
  pass "a certificate without the apex is refused, the installed one kept"
else fail "a certificate without the apex: $(cat "$tmp/out")"; fi

# 5. A key that is not the certificate's: refused.
if FAKE_OTHER_KEY=1 run >"$tmp/out" 2>&1; then fail "a mismatched key is refused"
elif grep -q "does not match" "$tmp/out" && [[ $(sha256sum "$tmp/certs/renoxium.test/fullchain.pem") == "$before" ]]; then pass "a mismatched key is refused, the installed one kept"
else fail "a mismatched key: $(cat "$tmp/out")"; fi

# 6. A new certificate replaces the installed one and reloads.
if run >"$tmp/out" 2>&1 && [[ $(reloads) == 1 && $(sha256sum "$tmp/certs/renoxium.test/fullchain.pem") != "$before" ]]; then pass "a new certificate replaces the old one and reloads"
else fail "a new certificate: $(cat "$tmp/out")"; fi

# 7. The token: a file path for lego, never a value in its argv, its environment or any output.
if grep -q "token_file=$tmp/token token_env=$" "$FAKE_LOG"; then pass "lego gets CLOUDFLARE_DNS_API_TOKEN_FILE and no token variable"; else fail "lego's token environment: $(cat "$FAKE_LOG")"; fi
if CLOUDFLARE_DNS_API_TOKEN=inherited run >"$tmp/out" 2>&1 && tail -n 1 "$FAKE_LOG" | grep -q "token_env=$"; then pass "an inherited CLOUDFLARE_DNS_API_TOKEN is cleared"; else fail "an inherited token variable: $(tail -n 1 "$FAKE_LOG")"; fi
if grep -rqF "$secret" "$FAKE_LOG" "$tmp/out" "$tmp/certs"; then fail "the token value never appears"; else pass "the token value appears in no argv, environment, output or installed file"; fi

# 8. The default reload (#399), with a fake systemctl on PATH that records its
# calls and answers is-active from $FAKE_ACTIVE. The first install happens
# before the worker runs (ops/single-host.md, step 8 before step 9): nothing
# is reloaded and the run succeeds.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/systemctl" <<'SH'
#!/bin/sh
echo "$*" >> "$FAKE_SYSTEMCTL_LOG"
case $1 in
  is-active) [ "${FAKE_ACTIVE:-0}" = 1 ] ;;
  reload) [ "${FAKE_RELOAD_FAILS:-0}" != 1 ] ;;
  *) exit 1 ;;
esac
SH
chmod 0755 "$tmp/bin/systemctl"
export FAKE_SYSTEMCTL_LOG=$tmp/systemctl.log
run_default() {
  PATH=$tmp/bin:$PATH "$renew" --domain renoxium.test --email ops@renoxium.test --token-file "$tmp/token" \
    --cert-dir "$tmp/certs" --lego-path "$tmp/acme" --lego-bin "$tmp/lego" --owner "$me"
}
rm -f "$FAKE_SYSTEMCTL_LOG"
if FAKE_ACTIVE=0 run_default >"$tmp/out" 2>&1 && head -n 1 "$tmp/out" | grep -q "installed a new certificate" && grep -q "is not active; nothing reloaded" "$tmp/out" \
  && ! grep -q '^reload' "$FAKE_SYSTEMCTL_LOG"; then
  pass "an inactive worker: the certificate is installed, the installed line comes first, nothing is reloaded, exit 0"
else fail "an inactive worker: $(cat "$tmp/out") / $(cat "$FAKE_SYSTEMCTL_LOG" 2>/dev/null)"; fi
rm -f "$FAKE_SYSTEMCTL_LOG"
if FAKE_ACTIVE=1 run_default >"$tmp/out" 2>&1 && grep -qx "reload renox-worker.service" "$FAKE_SYSTEMCTL_LOG" && tail -n 1 "$tmp/out" | grep -q "worker reloaded"; then
  pass "an active worker is reloaded (systemctl reload renox-worker.service) after the installed line"
else fail "an active worker: $(cat "$tmp/out") / $(cat "$FAKE_SYSTEMCTL_LOG" 2>/dev/null)"; fi
before=$(sha256sum "$tmp/certs/renoxium.test/fullchain.pem")
if FAKE_ACTIVE=1 FAKE_RELOAD_FAILS=1 run_default >"$tmp/out" 2>&1; then fail "a failed reload fails the run"
elif head -n 1 "$tmp/out" | grep -q "installed a new certificate" && grep -q "reload renox-worker.service failed" "$tmp/out" && [[ $(sha256sum "$tmp/certs/renoxium.test/fullchain.pem") != "$before" ]]; then
  pass "a failed reload fails the run, after the installed line, with the new certificate in place"
else fail "a failed reload: $(cat "$tmp/out")"; fi

if [[ $failures -ne 0 ]]; then echo "$failures failed" >&2; exit 1; fi
echo "all passed"
