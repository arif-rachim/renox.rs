#!/usr/bin/env bash
# Tests of renox-alert.sh (#450). curl and journalctl are stubs on PATH that
# record their arguments and standard input: no network. Proves: the alert
# names the unit and carries its last journal lines; the URL reaches curl on
# its standard input, never in its argv or the output; without alert.env it
# exits 0 and says so; an unknown key, a plain-http URL and a bad unit name
# are refused. Threat-model row (docs/24-threat-model.md): "Secrets in logs,
# errors, bundle, responses".
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
alert=$here/renox-alert.sh
command -v python3 >/dev/null 2>&1 || { echo "SKIP renox-alert test: python3 is not installed"; exit 0; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

secret="https://hooks.example.test/services/T000/B000/not-a-real-secret"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CURL_ARGS"
cat > "$CURL_STDIN"
STUB
cat > "$tmp/bin/journalctl" <<'STUB'
#!/usr/bin/env bash
echo "backup-control-db: pg_dump failed"
STUB
chmod +x "$tmp/bin/curl" "$tmp/bin/journalctl"
export PATH="$tmp/bin:$PATH" CURL_ARGS="$tmp/args" CURL_STDIN="$tmp/stdin"

printf 'ALERT_WEBHOOK_URL=%s\n' "$secret" > "$tmp/alert.env"
out=$(ALERT_ENV="$tmp/alert.env" "$alert" renox-backup-db.service 2>&1)
if grep -q "renox-backup-db.service failed on" <<< "$out"; then pass "the alert names the unit"; else fail "the alert names the unit: $out"; fi
if grep -q -- "$secret" <<< "$out" || grep -q -- "$secret" "$tmp/args"; then fail "the URL leaked to the output or argv"; else pass "the URL is neither in the output nor in curl's argv"; fi
if grep -q "url = \"$secret\"" "$tmp/stdin"; then pass "curl gets the URL on stdin"; else fail "curl gets the URL on stdin"; fi
if grep -q 'pg_dump failed' "$tmp/args"; then pass "the body carries the unit's last journal lines"; else fail "the body carries the journal lines"; fi

out=$(ALERT_ENV="$tmp/none.env" "$alert" renox-billing.service 2>&1) && grep -q "only in this journal" <<< "$out" && pass "no alert.env: exit 0, journal only" || fail "no alert.env: $out"
printf 'OTHER=1\n' > "$tmp/bad.env"
if ALERT_ENV="$tmp/bad.env" "$alert" x.service >/dev/null 2>&1; then fail "an unknown key is refused"; else pass "an unknown key is refused"; fi
printf 'ALERT_WEBHOOK_URL=http://hooks.example.test/x\n' > "$tmp/http.env"
if ALERT_ENV="$tmp/http.env" "$alert" x.service >/dev/null 2>&1; then fail "plain http is refused"; else pass "plain http is refused"; fi
if "$alert" 'x.service; rm -rf /' >/dev/null 2>&1; then fail "a bad unit name is refused"; else pass "a bad unit name is refused"; fi

[[ $fails -eq 0 ]] || { echo "$fails failed"; exit 1; }
echo "renox-alert: all passed"
