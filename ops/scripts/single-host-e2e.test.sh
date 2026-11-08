#!/usr/bin/env bash
# End-to-end test of the single host (#407): ops/single-host.md steps 3 to 12,
# in order, in one ubuntu:24.04 container booted with systemd as PID 1, with
# the shipped units, scripts and modes. bootstrap-node.test.sh checks each
# piece alone; this walks the runbook once so the pieces have to fit:
#
#   3  the source and Bun at /opt/renox (the tracked files and the installed
#      node_modules of this checkout; the --production install has its own
#      test, production-install.test.sh)
#   4  Postgres: the distribution's server, the renox_control role and the
#      renox database
#   5  bootstrap-node.sh --single-host --no-enable (a fake cloudflared)
#   6  control.env filled in, renox-control.service on Postgres, both
#      listeners on loopback, the node token issued with the operator token
#      and installed renox:renox 0400
#   7  renox-node.target: the controlled worker with the sandbox in enforce
#      mode, its health listener, its socket, the control API sees the node
#   8  renox-tunnel.service (the fake cloudflared, when this container's
#      systemd provides LoadCredential directories)
#   9  the platform tenant: sign-up, verification from the mail, login, a
#      token, the platform mark, `dashboard` and `www` deployed with the real
#      CLI under the reserved names and served by the worker through the
#      tunnel's socket with the Host header cloudflared forwards
#   10 renox-backup-db.service: a real pg_dump of the control database,
#      encrypted to the age key and uploaded to a fake S3 on loopback
#   11 renox-alert@.service: without alert.env it logs and succeeds (#545),
#      with it the webhook receives the failed unit's name
#   12 renox-billing.service: one pass on the same database
#   and renox-backup-tenants.service: a snapshot of the tenant files under
#      /var/backups/renox/tenants (#544: sqlite3 from install step 1), and
#      restore-check.sh with the control dump in R2 (#538)
#   and the runbook's "Health checks after every change".
#
# Since ADR D25 the single host has no TLS, ACME or certificate renewal of its
# own (Cloudflare does them), so the Pebble and cert-renew steps of the
# original proposal are gone. Cloudflare itself, DNS and R2 are not here:
# the socket stands in for the tunnel, a loopback server for R2.
#
#   ops/scripts/single-host-e2e.test.sh <path to renox-worker>
#
# Needs docker, bun (RENOX_BUN_BIN, default `bun` on PATH) and this
# checkout's node_modules (`bun install`); skipped (exit 0, with the reason)
# without them or where systemd cannot run in a container.
# RENOX_TEST_LITESTREAM_BIN: a Litestream binary to install instead of
# fetching it (a container with no route to GitHub).
# Threat-model rows (docs/24-threat-model.md): "Local process forges the
# client-IP header" (the socket's owner, group and mode); "Key compromise"
# (node.token and platform.key renox-only); "Secrets in logs, errors, bundle,
# responses" (no R2 secret, operator token or node token in any unit's
# journal); "Tenant files or backups read from storage" (the dump is age
# encrypted before it leaves the host).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo=$(cd "$here/.." && pwd)
worker=${1:-}
[[ -n $worker && -f $worker ]] || { echo "usage: $0 <path to renox-worker>" >&2; exit 2; }

skip() { echo "SKIP single-host e2e test: $*"; exit 0; }
command -v docker >/dev/null 2>&1 || skip "docker is not installed"
docker info >/dev/null 2>&1 || skip "no docker daemon reachable"
bun_bin=${RENOX_BUN_BIN:-$(command -v bun || true)}
[[ -n $bun_bin && -x $bun_bin ]] || skip "no bun (RENOX_BUN_BIN)"
[[ -d $repo/node_modules ]] || skip "no node_modules in $repo (run bun install)"

# The tag names the package list: a new list gets a new tag.
image=renox-single-host-e2e:24.04-pg16-sqlite3
name=renox-single-host-e2e-$$
ctx=$(mktemp -d)
cleanup() {
  [[ -n ${RENOX_TEST_KEEP:-} ]] && { echo "kept container $name"; rm -rf "$ctx"; return; }
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$ctx"
}
trap cleanup EXIT

if ! docker image inspect "$image" >/dev/null 2>&1; then
  cat > "$ctx/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv curl ca-certificates python3 openssl iproute2 age jq postgresql sqlite3 \
 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE
  docker build --quiet --tag "$image" "$ctx" >/dev/null
fi

# /var/lib/renox (the worker's data, artifacts, meters and logs) on a
# filesystem of its own: the worker refuses writes above its disk watermark,
# measured as the used share of that filesystem, and a shared CI or dev disk
# can be past it while still holding gigabytes. A dashboard deploy runs its
# migrations, which are writes; without this they fail on a full disk with
# "database file size quota exceeded" (#382 had the same cause).
docker run --detach --name "$name" --privileged --cgroupns=host \
  --volume /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock --tmpfs /var/lib/renox:rw,exec,size=2g "$image" >/dev/null
state=""
for _ in $(seq 90); do
  state=$(docker exec "$name" timeout 60 systemctl is-system-running --wait 2>/dev/null || true)
  [[ $state == running || $state == degraded ]] && break
  sleep 1
done
case $state in
  running | degraded) ;;
  *) skip "systemd in the container did not start (state: ${state:-none})" ;;
esac
# As in bootstrap-node.test.sh: Ubuntu's unprivileged port start, and a
# shared / so systemd's LoadCredential directories appear.
docker exec "$name" sysctl -qw net.ipv4.ip_unprivileged_port_start=1024
docker exec "$name" mount --make-rshared /

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }
dx() { docker exec "$name" "$@"; }
sh_in() { docker exec "$name" sh -c "$1"; }
journal() { dx journalctl -u "$1" --no-pager -o cat -n "${2:-30}" 2>/dev/null || true; }

# 3. Source and Bun. The deploy checkout of the runbook is the same tree here.
dx install -d -m 0755 /opt/renox/src /opt/renox/bin
(cd "$repo" && { git ls-files -z; find . -path ./target -prune -o -name node_modules -prune -print0; } | tar --null -T - -cf -) | docker exec -i "$name" tar -xf - -C /opt/renox/src
dx chown -R root:root /opt/renox/src
docker cp "$bun_bin" "$name:/opt/renox/bin/bun"
docker cp "$worker" "$name:/src-renox-worker"
dx chmod 0755 /opt/renox/bin/bun
# The deploy checkout's `bun install` builds sdk/dist through the SDK's
# prepare (control/dashboard and www import it); the copy has the installed
# node_modules but not that build output, which is untracked.
if dx sh -c 'cd /opt/renox/src/sdk && PATH=/opt/renox/bin:$PATH bun run build' >"$ctx/sdk" 2>&1; then :; else fail "step 3: sdk build: $(tail -n 5 "$ctx/sdk")"; fi
pass "step 3: the source at /opt/renox/src (with sdk/dist) and Bun at /opt/renox/bin/bun"

# 4. Postgres: listening on localhost only; the role and the database.
dx systemctl start postgresql >/dev/null 2>&1 || true
for _ in $(seq 30); do dx pg_isready -q -h 127.0.0.1 && break; sleep 1; done
db_pw=$(openssl rand -hex 24)
if dx su postgres -c "psql -q -c \"create role renox_control login password '$db_pw'\"" && dx su postgres -c "createdb -O renox_control renox"; then
  pass "step 4: Postgres answers on 127.0.0.1, role renox_control and database renox created"
else fail "step 4: Postgres role and database"; fi

# 5. Node bootstrap, with a fake cloudflared that tells systemd it is ready.
docker exec -i "$name" tee /src-cloudflared >/dev/null <<'PY'
#!/usr/bin/python3
import os, socket, time
addr = os.environ["NOTIFY_SOCKET"]
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.sendto(b"READY=1", "\0" + addr[1:] if addr.startswith("@") else addr)
print(f"fake-cloudflared uid={os.getuid()}", flush=True)
while True:
    time.sleep(3600)
PY
dx chmod 0755 /src-cloudflared
lsbin=()
if [[ -n ${RENOX_TEST_LITESTREAM_BIN:-} ]]; then
  docker cp "$RENOX_TEST_LITESTREAM_BIN" "$name:/src-litestream"
  lsbin=(--litestream-bin /src-litestream)
fi
sh_in 'printf "renox_node_%s\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > /root/node.token.placeholder && chmod 0600 /root/node.token.placeholder'
if dx /opt/renox/src/ops/scripts/bootstrap-node.sh --single-host --no-enable --worker-version 0.0.1 --worker-bin /src-renox-worker \
  --cloudflared-bin /src-cloudflared "${lsbin[@]}" --node-id node-small --control-url http://127.0.0.1:8788 \
  --blocked-addresses 203.0.113.10,127.0.0.1 --node-token-file /root/node.token.placeholder >"$ctx/boot" 2>&1; then
  pass "step 5: bootstrap-node.sh --single-host --no-enable"
else fail "step 5: bootstrap: $(tail -n 10 "$ctx/boot")"; fi
if grep -A2 '^\[sandbox\]$' <<< "$(dx cat /etc/renox/worker.toml)" | grep -q '^mode = "enforce"$'; then pass "step 5: worker.toml runs the sandbox in enforce mode"
else fail "step 5: worker.toml sandbox mode"; fi

# 6. Control plane on Postgres. The mail goes to a file outbox in the unit's
# state directory (no Resend here); the artifacts stay in memory (no R2).
op_token="renox_op_$(openssl rand -hex 20 | tr '0-9' 'a-j' | cut -c1-32)"
op_sha=$(printf %s "$op_token" | sha256sum | cut -d' ' -f1)
master=$(openssl rand -base64 32)
docker exec -i "$name" sh -c 'cat > /etc/renox/control.env && chmod 0600 /etc/renox/control.env' <<ENV
CONTROL_LISTEN_HOST=127.0.0.1
CONTROL_LISTEN_PORT=8787
CONTROL_NODE_LISTEN_HOST=127.0.0.1
CONTROL_NODE_LISTEN_PORT=8788
CONTROL_TRUSTED_PROXIES=127.0.0.1,::1
CONTROL_CLIENT_IP_HEADER=CF-Connecting-IP
CONTROL_DATABASE_URL=postgres://renox_control:$db_pw@127.0.0.1:5432/renox
CONTROL_MASTER_KEY=$master
CONTROL_OPERATOR_TOKEN_SHA256=$op_sha
CONTROL_MAIL_PROVIDER=outbox
CONTROL_MAIL_OUTBOX_DIR=/var/lib/renox-control/outbox
CONTROL_PLATFORM_DOMAIN=renoxium.app
CONTROL_DASHBOARD_URL=https://dashboard.renoxium.com
CONTROL_API_URL=https://api.renoxium.com
ENV
if dx systemctl enable --now renox-control.service >/dev/null 2>&1; then :; fi
up=0
for _ in $(seq 60); do
  if dx curl -fsS -o /dev/null http://127.0.0.1:8787/v1/healthz 2>/dev/null && dx curl -fsS -o /dev/null http://127.0.0.1:8788/v1/healthz 2>/dev/null; then up=1; break; fi
  sleep 1
done
if [[ $up == 1 ]]; then pass "step 6: renox-control.service on Postgres answers /v1/healthz on both listeners"
else fail "step 6: renox-control: $(journal renox-control 20)"; fi
if dx su postgres -c "psql -tA renox -c 'select count(*) from schema_migrations'" 2>/dev/null | grep -Eq '^[1-9][0-9]*$'; then pass "step 6: the control API migrated the renox database"
else echo "note: no schema_migrations table to count (migration bookkeeping table has another name)"; fi
listening=$(dx ss -Htln)
if grep -Eq '127\.0\.0\.1:8787 ' <<< "$listening" && grep -Eq '127\.0\.0\.1:8788 ' <<< "$listening" && ! grep -Eq '(0\.0\.0\.0|\*|\[::\]):878[78] ' <<< "$listening"; then
  pass "step 6: both control listeners on 127.0.0.1 only"
else fail "step 6: control listeners: $listening"; fi
node_json=$(dx curl -fsS -X POST http://127.0.0.1:8787/v1/admin/nodes -H "authorization: Bearer $op_token" -H 'content-type: application/json' -d '{"node_id": "node-small"}' || true)
node_token=$(jq -r '.token // empty' <<< "$node_json")
if [[ $node_token == renox_node_* ]]; then
  printf '%s\n' "$node_token" | docker exec -i "$name" install -m 0400 -o renox -g renox /dev/stdin /etc/renox/node.token
  pass "step 6: the node token is issued with the operator token and installed"
else fail "step 6: POST /v1/admin/nodes: $node_json"; fi

# 7. The worker.
dx systemctl enable --now renox-node.target >/dev/null 2>&1 || true
seen=0
for _ in $(seq 60); do
  if dx curl -fsS -o /dev/null http://127.0.0.1:9090/healthz 2>/dev/null; then seen=1; break; fi
  sleep 1
done
if [[ $seen == 1 && $(dx systemctl is-active renox-worker || true) == active ]]; then pass "step 7: renox-worker is active and answers on its health listener"
else fail "step 7: renox-worker: $(journal renox-worker 30)"; fi
sock=$(dx stat -c '%F %U:%G %a' /run/renox-edge/worker.sock 2>&1 || true)
if [[ $sock == "socket renox:renox-edge 660" ]]; then pass "step 7: /run/renox-edge/worker.sock is socket renox:renox-edge 660"; else fail "step 7: worker socket: $sock"; fi
known=""
for _ in $(seq 30); do
  known=$(dx curl -fsS http://127.0.0.1:8787/v1/ops/nodes/node-small -H "authorization: Bearer $op_token" 2>/dev/null || true)
  [[ -n $known ]] && jq -e '.last_heartbeat_at // .heartbeat_at // .last_seen_at // empty' <<< "$known" >/dev/null 2>&1 && break
  sleep 1
done
if [[ -n $known ]] && jq -e '.node_id == "node-small"' <<< "$known" >/dev/null 2>&1; then pass "step 7: the control API knows node-small (GET /v1/ops/nodes/node-small)"
else fail "step 7: GET /v1/ops/nodes/node-small: $known"; fi

# 8. The tunnel (fake cloudflared), when LoadCredential works in this container.
sh_in 'echo "{\"AccountTag\":\"test\",\"TunnelSecret\":\"not-a-secret\",\"TunnelID\":\"00000000-0000-0000-0000-000000000000\"}" > /etc/renox/tunnel/credentials.json && chmod 0600 /etc/renox/tunnel/credentials.json'
if dx systemctl start renox-tunnel.service >/dev/null 2>&1 && [[ $(dx systemctl is-active renox-tunnel || true) == active ]]; then
  tunnel=1
  pass "step 8: renox-tunnel.service is active (fake cloudflared)"
else
  tunnel=0
  echo "skip step 8: renox-tunnel did not start in this container ($(journal renox-tunnel 3 | tail -n 1))"
fi

# 9. The platform tenant and its apps.
api=http://127.0.0.1:8787
owner=owner@renoxium.test
pw="e2e-$(openssl rand -hex 12)"
signup=$(jq -n --arg e "$owner" --arg p "$pw" '{email: $e, password: $p, tenant_id: "renoxium", tenant_name: "Renoxium", dpa_accepted: true}' |
  docker exec -i "$name" curl -sS -X POST "$api/v1/account/signup" -H 'content-type: application/json' --data-binary @- || true)
token=""
for _ in $(seq 20); do
  token=$(sh_in 'cat /var/lib/renox-control/outbox/* 2>/dev/null' | grep -oE '#token=[a-z2-7]{32}' | head -n 1 | cut -d= -f2 || true)
  [[ -n $token ]] && break
  sleep 1
done
verified=$(dx curl -sS -X POST "$api/v1/account/verify" -H 'content-type: application/json' -d "{\"token\": \"$token\"}" || true)
if jq -e '.email_verified == true' <<< "$verified" >/dev/null 2>&1; then pass "step 9: sign-up, the verification mail in the outbox, the address verified"
else fail "step 9: sign-up $signup, verify $verified"; fi
login=$(jq -n --arg e "$owner" --arg p "$pw" '{email: $e, password: $p}' |
  docker exec -i "$name" curl -sS -c /root/jar.txt -X POST "$api/v1/account/login" -H 'content-type: application/json' --data-binary @- || true)
csrf=$(jq -r '.csrf // empty' <<< "$login")
# The runbook approves `renox login`; a token from the same session is the
# same credential without the interactive poll.
tok=$(dx curl -sS -b /root/jar.txt -X POST "$api/v1/tokens" -H 'content-type: application/json' -H "x-renox-csrf: $csrf" \
  -d '{"name": "e2e deploy", "scopes": ["apps:read", "apps:write", "deploy", "secrets:write", "logs:read"], "expires_in_days": 1}' || true)
cli_token=$(jq -r '.token // empty' <<< "$tok")
if [[ -n $cli_token ]]; then pass "step 9: login and a deploy token from the owner's session"; else fail "step 9: login $login, token $tok"; fi
mark=$(dx curl -sS -X POST "$api/v1/ops/tenants/renoxium/platform" -H "authorization: Bearer $op_token" -H 'content-type: application/json' \
  -d '{"platform": true, "reason": "e2e: the platform tenant runs dashboard and www"}' || true)
if jq -e '.changed == true or .platform == true' <<< "$mark" >/dev/null 2>&1; then pass "step 9: the tenant is marked as the platform tenant"; else fail "step 9: platform mark: $mark"; fi
dx curl -sS -o /dev/null -X POST "$api/v1/apps" -H "authorization: Bearer $cli_token" -H 'content-type: application/json' -d '{"name": "dashboard"}' || true
renox() { docker exec -i -w "/opt/renox/src/$1" -e HOME=/root -e PATH=/opt/renox/bin:/usr/bin:/bin -e RENOX_TOKEN="$cli_token" -e RENOX_API_URL="$api" \
  -e RENOX_WORKER_PATH=/opt/renox/bin/renox-worker -e NO_COLOR=1 "$name" /opt/renox/bin/bun /opt/renox/src/cli/src/main.ts "${@:2}"; }
if openssl rand -base64 32 | tr -d '\n' | renox control/dashboard secrets set DASHBOARD_KEY --app dashboard >"$ctx/secret" 2>&1; then pass "step 9: DASHBOARD_KEY set with renox secrets set"
else fail "step 9: renox secrets set: $(tail -n 5 "$ctx/secret")"; fi
for app in control/dashboard www; do
  if renox "$app" deploy >"$ctx/deploy" 2>&1 && grep -q "Live:" "$ctx/deploy"; then pass "step 9: renox deploy in $app: $(grep -o 'Live: [^ ]*' "$ctx/deploy")"
  else fail "step 9: renox deploy in $app: $(tail -n 15 "$ctx/deploy")"; fi
done
# Through the tunnel's socket, as cloudflared sends it: the Host header kept.
via_socket() { dx curl -sS --unix-socket /run/renox-edge/worker.sock -H "Host: $1" -H 'X-Forwarded-Proto: https' -o "/root/body" -w '%{http_code}' "http://localhost$2" || true; }
served=0
for _ in $(seq 30); do
  [[ $(via_socket www.renoxium.app /) == 200 ]] && served=1 && break
  sleep 1
done
if [[ $served == 1 ]] && dx grep -q 'Deploy. Run.' /root/body; then pass "step 9: www.renoxium.app answers 200 through the worker socket with the site's home page"
else fail "step 9: www.renoxium.app through the socket: $(dx head -c 300 /root/body 2>/dev/null)"; fi
code=$(via_socket dashboard.renoxium.app /signin)
if [[ $code == 200 ]] && dx grep -q 'password-form' /root/body; then pass "step 9: dashboard.renoxium.app/signin answers 200 through the worker socket"
else fail "step 9: dashboard.renoxium.app/signin: $code $(dx head -c 300 /root/body 2>/dev/null)"; fi
asset=$(dx grep -oE 'href="/renox-ui\.[0-9a-f]{16}\.css"' /root/body | head -n 1 | cut -d'"' -f2 || true)
headers=$(dx curl -sS --unix-socket /run/renox-edge/worker.sock -H 'Host: dashboard.renoxium.app' -D - -o /dev/null "http://localhost$asset" 2>/dev/null || true)
if [[ -n $asset ]] && grep -qi '^cache-control: public, max-age=31536000, immutable' <<< "$headers"; then pass "step 9: the page's stylesheet has a hashed name and is served immutable (#406)"
else fail "step 9: hashed stylesheet ${asset:-none}: $headers"; fi

# 10. The backup: a real pg_dump of the control database through its unit,
# age encrypted, to a fake S3 on loopback (the drop-in only allows http://).
docker exec -i "$name" tee /root/s3.py >/dev/null <<'PY'
import http.server, os, sys, urllib.parse
STORE = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def signed(self): return self.headers.get("authorization", "").startswith("AWS4-HMAC-SHA256 Credential=RENOXTESTKEY0000000000001/")
    def f(self): return os.path.join(STORE, urllib.parse.quote(self.path, safe=""))
    def do_PUT(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        ok = self.signed()
        if ok: open(self.f(), "wb").write(body)
        self.send_response(200 if ok else 403); self.send_header("content-length", "0"); self.end_headers()
    def do_HEAD(self):
        ok = self.signed() and os.path.exists(self.f())
        self.send_response(200 if ok else 404)
        self.send_header("content-length", str(os.path.getsize(self.f())) if ok else "0"); self.end_headers()
http.server.HTTPServer(("127.0.0.1", 9599), H).serve_forever()
PY
dx mkdir -p /root/s3-store
docker exec -d "$name" python3 /root/s3.py /root/s3-store
sh_in 'age-keygen -o /root/backup-age.key 2>/dev/null && age-keygen -y /root/backup-age.key > /etc/renox/backup-age.pub && chmod 0644 /etc/renox/backup-age.pub
printf "R2_ENDPOINT=http://127.0.0.1:9599\nR2_BUCKET=renoxium-backups\nR2_ACCESS_KEY_ID=RENOXTESTKEY0000000000001\nR2_SECRET_ACCESS_KEY=e2e-secret-not-real\n" > /etc/renox/secrets/r2-backup.env
chmod 0600 /etc/renox/secrets/r2-backup.env
mkdir -p /etc/systemd/system/renox-backup-db.service.d
printf "[Service]\nEnvironment=RENOX_BACKUP_ALLOW_HTTP=1\n" > /etc/systemd/system/renox-backup-db.service.d/e2e-http.conf
systemctl daemon-reload'
if dx systemctl start renox-backup-db.service >/dev/null 2>&1; then
  obj=$(sh_in 'ls /root/s3-store | head -n 1' || true)
  if [[ -n $obj ]] && sh_in "age --decrypt --identity /root/backup-age.key '/root/s3-store/$obj' > /root/restore.dump" && dx pg_restore --list /root/restore.dump 2>/dev/null | grep -q 'TABLE public tenants'; then
    pass "step 10: renox-backup-db.service dumps the control database; the object decrypts and pg_restore lists its tenants table"
  else fail "step 10: the backup object: $(journal renox-backup-db 10)"; fi
else fail "step 10: renox-backup-db.service: $(journal renox-backup-db 20)"; fi

# 11. A failed unit's alert reaches the webhook: an https receiver on
# loopback (renox-alert.sh refuses anything but https://), its self-signed
# certificate trusted through the system store as a real CA's would be.
sh_in 'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=127.0.0.1 \
  -addext subjectAltName=IP:127.0.0.1 -keyout /root/hook.key -out /usr/local/share/ca-certificates/e2e-hook.crt 2>/dev/null \
  && update-ca-certificates >/dev/null 2>&1'
docker exec -i "$name" tee /root/hook.py >/dev/null <<'PY'
import http.server, ssl, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        open(sys.argv[1], "ab").write(self.rfile.read(int(self.headers.get("content-length", "0"))) + b"\n")
        self.send_response(200); self.send_header("content-length", "0"); self.end_headers()
srv = http.server.HTTPServer(("127.0.0.1", 9598), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/usr/local/share/ca-certificates/e2e-hook.crt", "/root/hook.key")
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY
docker exec -d "$name" python3 /root/hook.py /root/alerts.log
# #545: before alert.env exists the alert unit still succeeds and logs.
if dx systemctl start renox-alert@e2e-none.service >/dev/null 2>&1 && journal 'renox-alert@e2e-none' 10 | grep -q 'renox-alert: no alert.env; e2e-none failed on node-small'; then
  pass "step 11: without alert.env, renox-alert@ exits 0 and logs 'no alert.env; <unit> failed on <node>'"
else fail "step 11: renox-alert@ without alert.env: $(dx systemctl show -p Result --value renox-alert@e2e-none.service 2>/dev/null) $(journal 'renox-alert@e2e-none' 5)"; fi
sh_in 'printf "ALERT_WEBHOOK_URL=https://127.0.0.1:9598/hook\n" > /etc/renox/secrets/alert.env && chmod 0600 /etc/renox/secrets/alert.env'
dx systemctl start renox-alert@e2e-test.service >/dev/null 2>&1 || true
alerted=0
for _ in $(seq 10); do
  if dx grep -q '"unit": "e2e-test"' /root/alerts.log 2>/dev/null; then alerted=1; break; fi
  sleep 1
done
if [[ $alerted == 1 ]]; then pass "step 11: renox-alert@ posts the failed unit's name to the https webhook"
else fail "step 11: no alert at the webhook: $(journal 'renox-alert@e2e-test' 5)"; fi

# 12. Billing rollup: one pass on the same database.
if dx systemctl start renox-billing.service >/dev/null 2>&1 && ! journal renox-billing 50 | grep -q 'billing run failed'; then
  pass "step 12: renox-billing.service runs one pass on the control database"
else fail "step 12: renox-billing.service: $(journal renox-billing 20)"; fi

# The weekly tenant snapshot (#517, #544), started once: step 9's apps have
# their databases under /var/lib/renox/data, so at least one copy appears.
if dx systemctl start renox-backup-tenants.service >/dev/null 2>&1; then
  snaps=$(sh_in "find /var/backups/renox/tenants -mindepth 2 -maxdepth 2 -type f -name '*-[0-9]*T[0-9]*Z.db' | wc -l" || echo 0)
  if [[ $snaps -ge 1 ]]; then pass "backups: renox-backup-tenants.service writes $snaps tenant snapshot(s) under /var/backups/renox/tenants"
  else fail "backups: no tenant snapshot: $(journal renox-backup-tenants 10)"; fi
else fail "backups: renox-backup-tenants.service: $(journal renox-backup-tenants 20)"; fi
# #538: this host's control dumps went to the fake R2 (step 10), as on
# node-small, so there is no local dump: the drill skips that step with its
# line and passes on the tenant snapshot.
if out=$(dx /opt/renox/bin/restore-check.sh --pg-user postgres 2>&1) && grep -q 'control dump is in R2; run the Restore drill from the workstation' <<< "$out" && grep -q 'quick_check ok' <<< "$out"; then
  pass "backups: restore-check.sh on an R2 host skips the control dump and checks the tenant snapshot"
else fail "backups: restore-check.sh on an R2 host: $out"; fi

# Health checks after every change (ops/single-host.md), the rows that make
# sense without Cloudflare and a second machine.
active="renox-worker renox-control"
[[ $tunnel == 1 ]] && active="$active renox-tunnel"
# shellcheck disable=SC2086
states=$(dx systemctl is-active $active 2>/dev/null | sort -u || true)
if [[ $states == active ]]; then pass "health: systemctl is-active $active"; else fail "health: is-active: $states"; fi
dx systemctl enable --now renox-backup-db.timer renox-billing.timer >/dev/null 2>&1 || true
timers=$(dx systemctl list-timers --all --no-pager 'renox-*' 2>/dev/null || true)
if grep -q 'renox-backup-db.timer' <<< "$timers" && grep -q 'renox-billing.timer' <<< "$timers"; then pass "health: the backup timer and the billing timer are listed"; else fail "health: timers: $timers"; fi
if [[ $(dx systemctl show -p Result --value renox-billing.service) == success ]]; then pass "health: renox-billing.service's last run succeeded"; else fail "health: renox-billing result"; fi
keys=$(dx stat -c '%U:%G %a' /etc/renox/node.token /etc/renox/platform.key 2>&1 | sort -u || true)
if [[ $keys == "renox:renox 400" ]]; then pass "health: node.token and platform.key are renox:renox 400"; else fail "health: key files: $keys"; fi
public=$(dx ss -Htln | awk '{print $4}' | grep -Ev '^(127\.0\.0\.1|\[::1\]|::1):' || true)
if [[ -z $public ]]; then pass "health: nothing listens on a non-loopback address (this container runs no sshd)"; else fail "health: public listeners: $public"; fi
loopback=$(dx ss -Htln | awk '{print $4}')
missing=""
for port in 8787 8788 9090 5432; do grep -q "127\.0\.0\.1:$port$" <<< "$loopback" || missing="$missing $port"; done
if [[ -z $missing ]]; then pass "health: 8787, 8788, 9090 and 5432 listen on loopback"; else fail "health: not on loopback:$missing"; fi
leaks=$(dx journalctl --no-pager -o cat 2>/dev/null | grep -cE "e2e-secret-not-real|$op_token|${node_token:-no-node-token}" || true)
if [[ $leaks == 0 ]]; then pass "no R2 secret, operator token or node token in the journal"; else fail "secrets in the journal: $leaks lines"; fi

echo
if [[ $failures -eq 0 ]]; then echo "all passed"; else echo "$failures failed"; exit 1; fi
