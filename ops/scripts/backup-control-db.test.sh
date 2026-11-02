#!/usr/bin/env bash
# Tests of backup-control-db.sh (#366), run by CI's ops step against a fake S3
# server on loopback that checks each request's AWS Signature Version 4 with
# the test key, and a fake pg_dump: no network, no R2 account, no Postgres.
# Proves: the dump is uploaded encrypted (the object decrypts with the test
# identity to pg_dump's output, and is not that output in the clear); the
# request is signed for region `auto`, service `s3`; a failing pg_dump uploads
# nothing; a group-readable credentials file, an unknown key in it and a
# private age key in the recipients file are refused; the secret never
# appears in curl's argv or in the output; a server refusing the upload fails
# the backup.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
backup=$here/backup-control-db.sh
skip() { echo "SKIP backup-control-db test: $*"; exit 0; }
command -v age >/dev/null 2>&1 || skip "age is not installed"
command -v age-keygen >/dev/null 2>&1 || skip "age-keygen is not installed"
command -v python3 >/dev/null 2>&1 || skip "python3 is not installed"
curl --help all 2>/dev/null | grep -q -- --aws-sigv4 || skip "curl has no --aws-sigv4"

tmp=$(mktemp -d)
server_pid=""
cleanup() { [[ -n $server_pid ]] && kill "$server_pid" 2>/dev/null; rm -rf "$tmp"; }
trap cleanup EXIT

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

key_id=RENOXTESTKEY0000000000001
secret=test-secret-not-real-$RANDOM$RANDOM$RANDOM

# The fake S3: PUT stores the body, HEAD answers its length, both only with a
# valid SigV4 signature for region auto / service s3. FAKE_REFUSE makes PUT 403.
cat > "$tmp/s3.py" <<'PY'
import hashlib, hmac, http.server, os, sys, urllib.parse
KEY, SECRET, STORE, PORTFILE = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def sign(key, msg): return hmac.new(key, msg.encode(), hashlib.sha256).digest()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def check(self):
        auth = self.headers.get("authorization", "")
        if not auth.startswith("AWS4-HMAC-SHA256 "): return False
        parts = dict(p.strip().split("=", 1) for p in auth[len("AWS4-HMAC-SHA256 "):].split(","))
        cred = parts["Credential"].split("/")
        if cred[0] != KEY or cred[2] != "auto" or cred[3] != "s3": return False
        signed = parts["SignedHeaders"].split(";")
        canon_headers = "".join(f"{h}:{' '.join(self.headers.get(h, '').split())}\n" for h in signed)
        u = urllib.parse.urlsplit(self.path)
        payload = self.headers.get("x-amz-content-sha256", "UNSIGNED-PAYLOAD")
        creq = "\n".join([self.command, u.path, u.query, canon_headers, parts["SignedHeaders"], payload])
        amz_date = self.headers["x-amz-date"]
        scope = "/".join(cred[1:])
        sts = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(creq.encode()).hexdigest()])
        k = sign(("AWS4" + SECRET).encode(), cred[1]); k = sign(k, cred[2]); k = sign(k, cred[3]); k = sign(k, "aws4_request")
        return hmac.compare_digest(hmac.new(k, sts.encode(), hashlib.sha256).hexdigest(), parts["Signature"])
    def path_file(self): return os.path.join(STORE, urllib.parse.quote(self.path, safe=""))
    def do_PUT(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        if os.environ.get("FAKE_REFUSE") == "1" or not self.check():
            self.send_response(403); self.send_header("content-length", "0"); self.end_headers(); return
        open(self.path_file(), "wb").write(body)
        self.send_response(200); self.send_header("content-length", "0"); self.end_headers()
    def do_HEAD(self):
        f = self.path_file()
        if not self.check() or not os.path.exists(f):
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
        self.send_response(200); self.send_header("content-length", str(os.path.getsize(f))); self.end_headers()
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(PORTFILE, "w").write(str(s.server_port))
s.serve_forever()
PY
mkdir -p "$tmp/store"
start_server() {
  [[ -n $server_pid ]] && kill "$server_pid" 2>/dev/null && wait "$server_pid" 2>/dev/null || true
  rm -f "$tmp/port"
  python3 "$tmp/s3.py" "$key_id" "$secret" "$tmp/store" "$tmp/port" &
  server_pid=$!
  for _ in $(seq 50); do [[ -s $tmp/port ]] && break; sleep 0.1; done
  port=$(cat "$tmp/port")
}
start_server

age-keygen -o "$tmp/identity" 2>/dev/null
age-keygen -y "$tmp/identity" > "$tmp/recipients"
write_env() {
  printf 'R2_ENDPOINT=http://127.0.0.1:%s\nR2_BUCKET=renoxium-backups\nR2_ACCESS_KEY_ID=%s\nR2_SECRET_ACCESS_KEY=%s\n' "$port" "$key_id" "$secret" > "$tmp/r2.env"
  chmod 0600 "$tmp/r2.env"
}
write_env

# A fake pg_dump, and a curl shim that records its argv.
mkdir -p "$tmp/bin"
printf '#!/bin/sh\nprintf "PGDMP fake dump of %%s\\n" "$*"\n' > "$tmp/bin/pg_dump"
printf '#!/bin/sh\necho "fails" >&2\nexit 3\n' > "$tmp/bin/pg_dump_fail"
real_curl=$(command -v curl)
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s"\nexec "%s" "$@"\n' "$tmp/curl.argv" "$real_curl" > "$tmp/bin/curl"
chmod 0755 "$tmp/bin/"*

run() { PATH=$tmp/bin:$PATH RENOX_BACKUP_ALLOW_HTTP=1 "$backup" --database renox --recipients "$tmp/recipients" --r2-env "$tmp/r2.env" --work-dir "$tmp" "$@"; }
objects() { find "$tmp/store" -type f | wc -l; }

# 1. A backup is uploaded, signed, encrypted, and decrypts to the dump.
if run >"$tmp/out" 2>&1 && grep -q "renoxium-backups/control-db/" "$tmp/out"; then pass "a backup is uploaded with a signed PUT and read back"
else fail "a backup is uploaded: $(cat "$tmp/out")"; fi
obj=$(find "$tmp/store" -type f | head -n 1)
if [[ -n $obj ]] && age --decrypt --identity "$tmp/identity" "$obj" 2>/dev/null | grep -q "PGDMP fake dump of --format=custom --compress=6 --dbname=renox"; then
  pass "the object decrypts with the identity to pg_dump's output"
else fail "the object decrypts to the dump"; fi
if [[ -n $obj ]] && ! grep -q "PGDMP" "$obj"; then pass "the object is not the dump in the clear"; else fail "the object is encrypted"; fi
if [[ $obj == *control-db%2F20[0-9][0-9]%2F[01][0-9]%2Fcontrol-db-20*Z.dump.age ]]; then pass "the key is control-db/<yyyy>/<mm>/control-db-<stamp>.dump.age"; else fail "the object key: $obj"; fi

# 2. A failing pg_dump uploads nothing.
n=$(objects)
if run --pg-dump pg_dump_fail >"$tmp/out" 2>&1; then fail "a failing pg_dump fails the backup"
elif [[ $(objects) == "$n" ]]; then pass "a failing pg_dump fails the backup and uploads nothing"
else fail "a failing pg_dump uploaded something"; fi

# 3. Refusals: credentials readable by the group, an unknown key, a private key as recipient, a wrong secret.
chmod 0640 "$tmp/r2.env"
if run >"$tmp/out" 2>&1; then fail "a group-readable credentials file is refused"; elif grep -q "readable by group or others" "$tmp/out"; then pass "a group-readable credentials file is refused"; else fail "group-readable: $(cat "$tmp/out")"; fi
write_env
printf 'EVIL=$(touch %s/pwned)\n' "$tmp" >> "$tmp/r2.env"
if run >"$tmp/out" 2>&1; then fail "an unknown key is refused"; elif grep -q "unknown key" "$tmp/out" && [[ ! -e $tmp/pwned ]]; then pass "an unknown key is refused and nothing in the file is executed"; else fail "unknown key: $(cat "$tmp/out")"; fi
write_env
if run --recipients "$tmp/identity" >"$tmp/out" 2>&1; then fail "a private key as recipients is refused"; else pass "a private age key as recipients is refused"; fi
sed -i "s/^R2_SECRET_ACCESS_KEY=.*/R2_SECRET_ACCESS_KEY=wrong-secret/" "$tmp/r2.env"
if run >"$tmp/out" 2>&1; then fail "a wrong secret fails the upload"; else pass "a request signed with another secret is refused by the server and fails the backup"; fi
write_env

# 4. A server that refuses the upload fails the backup.
FAKE_REFUSE=1 start_server
write_env
if FAKE_REFUSE=1 run >"$tmp/out" 2>&1; then fail "a refused upload fails the backup"; elif grep -q "upload of control-db/.* failed" "$tmp/out"; then pass "a refused upload fails the backup (after curl's retries)"; else fail "a refused upload: $(cat "$tmp/out")"; fi

# 5. The secret never reaches curl's argv or any output.
if grep -rqF "$secret" "$tmp/curl.argv" "$tmp/out"; then fail "the secret never appears in argv or output"; else pass "the secret appears in no curl argv and no output"; fi

if [[ $failures -ne 0 ]]; then echo "$failures failed" >&2; exit 1; fi
echo "all passed"
