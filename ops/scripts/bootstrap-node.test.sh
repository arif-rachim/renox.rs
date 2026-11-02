#!/usr/bin/env bash
# Container test of bootstrap-node.sh (#252), run by CI's rust job after it
# built renox-worker: an ubuntu:24.04 container booted with systemd as PID 1
# runs the bootstrap, and `systemctl is-active renox-worker` must answer
# `active` with the worker's cgroup under renox-free.slice. Also checks that
# a second run changes nothing and that another version without --upgrade
# is refused.
#
#   ops/scripts/bootstrap-node.test.sh <path to renox-worker>
#
# Skipped (exit 0, with the reason) where systemd cannot run in a container:
# no docker daemon, or the container's systemd does not reach `running`.
# The worker runs in local mode with an empty route table, so no control
# plane is needed; Litestream is fetched through fetch-litestream.sh.
#
# The single host (#366): `--single-host` with fake cloudflared and lego
# binaries; the worker.toml it writes (control URL on loopback, the blocked
# addresses, the sandbox), its refusals, the files, users and modes it
# installs; renox-tunnel.service gets its config and credentials through
# LoadCredential and cannot read the root-only file itself;
# renox-cert-renew.service installs a certificate from a fake lego and
# reloads the worker; renox-control.service (when Bun and the repository's
# node_modules are on this machine: RENOX_BUN_BIN, default `bun` on PATH)
# listens on 127.0.0.1 only and refuses 0.0.0.0 behind loopback proxies.
# RENOX_TEST_STUB_WORKER=1 says the worker binary is a stand-in (a local run
# without a build), so the real config parser is not asked.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
worker=${1:-}
[[ -n $worker && -f $worker ]] || { echo "usage: $0 <path to renox-worker>" >&2; exit 2; }

skip() { echo "SKIP bootstrap-node container test: $*"; exit 0; }
command -v docker >/dev/null 2>&1 || skip "docker is not installed"
docker info >/dev/null 2>&1 || skip "no docker daemon reachable"

image=renox-bootstrap-test:24.04
name=renox-bootstrap-test-$$
ctx=$(mktemp -d)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$ctx"
}
trap cleanup EXIT

# An image that already exists under this tag is reused (a local build behind a proxy).
if ! docker image inspect "$image" >/dev/null 2>&1; then
  cat > "$ctx/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv curl ca-certificates python3 openssl iproute2 \
 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE
  docker build --quiet --tag "$image" "$ctx" >/dev/null
fi

docker run --detach --name "$name" --privileged --cgroupns=host \
  --volume /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$image" >/dev/null

# The bus may not exist for the first seconds, so ask until systemd answers.
state=""
for _ in $(seq 60); do
  state=$(docker exec "$name" timeout 60 systemctl is-system-running --wait 2>/dev/null || true)
  [[ $state == running || $state == degraded ]] && break
  sleep 1
done
case $state in
  running | degraded) ;;
  *) skip "systemd in the container did not start (state: ${state:-none})" ;;
esac

docker exec "$name" mkdir -p /src
docker cp "$here" "$name:/src/ops"
docker cp "$worker" "$name:/src/renox-worker"
docker exec -i "$name" tee /src/worker.toml >/dev/null <<'TOML'
listen = "127.0.0.1:8080"
data_dir = "/var/lib/renox/data"
artifacts_dir = "/var/lib/renox/artifacts"
routes_file = "/var/lib/renox/data/routes.json"
meters_dir = "/var/lib/renox/meters"
logs_dir = "/var/lib/renox/logs"
node_id = "node-bootstrap-test"
TOML

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

# RENOX_TEST_LITESTREAM_BIN: a Litestream binary to install instead of fetching
# it (a local run whose container has no route to GitHub).
lsbin=()
if [[ -n ${RENOX_TEST_LITESTREAM_BIN:-} ]]; then
  docker cp "$RENOX_TEST_LITESTREAM_BIN" "$name:/src/litestream"
  lsbin=(--litestream-bin /src/litestream)
fi
boot() { docker exec "$name" /src/ops/scripts/bootstrap-node.sh --worker-version 0.0.1 --worker-bin /src/renox-worker --config /src/worker.toml "${lsbin[@]}" "$@"; }

# 1. Install without starting, then add the (empty) route table the local mode needs.
if boot --no-enable >/dev/null; then pass "bootstrap installs the node (--no-enable)"; else fail "bootstrap installs the node (--no-enable)"; fi
docker exec "$name" sh -c 'echo "{\"version\": 0, \"entries\": []}" > /var/lib/renox/data/routes.json && chown renox:renox /var/lib/renox/data/routes.json'

# 2. Second run, same version: enables and starts the target.
if boot >/dev/null; then pass "a second run with the same version succeeds and starts the node"; else fail "a second run with the same version succeeds"; fi
sleep 3
active=$(docker exec "$name" systemctl is-active renox-worker 2>/dev/null || true)
if [[ $active == active ]]; then pass "systemctl is-active renox-worker: active"; else
  fail "systemctl is-active renox-worker: ${active:-none}"
  docker exec "$name" journalctl -u renox-worker --no-pager -n 50 >&2 || true
fi
cgroup=$(docker exec "$name" systemctl show -p ControlGroup --value renox-worker)
if [[ $cgroup == */renox-free.slice/renox-worker.service ]]; then pass "the worker runs in renox-free.slice ($cgroup)"; else fail "the worker runs in renox-free.slice ($cgroup)"; fi
for unit in renox-node.target renox-free.slice; do
  if [[ $(docker exec "$name" systemctl is-active "$unit" 2>/dev/null || true) == active ]]; then pass "$unit is active"; else fail "$unit is active"; fi
done
if docker exec "$name" test -x /opt/renox/bin/litestream; then pass "the pinned Litestream is installed"; else fail "the pinned Litestream is installed"; fi
owner=$(docker exec "$name" stat -c %U /var/lib/renox/data)
if [[ $owner == renox ]]; then pass "the data dir belongs to renox"; else fail "the data dir belongs to renox ($owner)"; fi

# 3. Another version without --upgrade is refused and leaves the node running.
if docker exec "$name" /src/ops/scripts/bootstrap-node.sh --worker-version 0.0.2 --worker-bin /src/renox-worker --config /src/worker.toml "${lsbin[@]}" 2>"$ctx/err"; then
  fail "another version without --upgrade is refused"
elif grep -q -- "--upgrade" "$ctx/err"; then
  pass "another version without --upgrade is refused"
else
  fail "another version without --upgrade is refused: $(cat "$ctx/err")"
fi

# 4. --upgrade installs it, keeps the previous binary for rollback and restarts.
if boot --upgrade >/dev/null 2>&1 && docker exec "$name" /src/ops/scripts/bootstrap-node.sh --worker-version 0.0.2 --worker-bin /src/renox-worker --config /src/worker.toml "${lsbin[@]}" --upgrade >/dev/null; then
  sleep 2
  if [[ $(docker exec "$name" cat /opt/renox/worker-version) == 0.0.2 && $(docker exec "$name" systemctl is-active renox-worker || true) == active ]]; then
    pass "--upgrade installs the new version and the worker restarts"
  else
    fail "--upgrade installs the new version and the worker restarts"
  fi
else
  fail "--upgrade installs the new version"
fi

# 5. The single host (#366). The local-mode worker.toml is set aside so the
# bootstrap writes the single-host one, then put back for the worker to run.
docker exec "$name" sh -c 'printf "renox_node_test\n" > /src/node.token && chmod 0600 /src/node.token'
# Fake cloudflared: proves it got both files through LoadCredential and that
# its dynamic user cannot read the root-only credentials file directly; then
# tells systemd it is ready, as the real one does.
docker exec -i "$name" tee /src/cloudflared >/dev/null <<'PY'
#!/usr/bin/python3
import os, socket, sys, time
cred = os.environ.get("CREDENTIALS_DIRECTORY", "")
args = sys.argv[1:]
got = f"{cred}/config.yml" in args and f"{cred}/credentials.json" in args and os.path.getsize(f"{cred}/credentials.json") > 0
try:
    open("/etc/renox/tunnel/credentials.json").read()
    direct = True
except OSError:
    direct = False
print(f"fake-cloudflared uid={os.getuid()} credentials={got} direct_read={direct}", flush=True)
addr = os.environ["NOTIFY_SOCKET"]
s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
s.sendto(b"READY=1", "\0" + addr[1:] if addr.startswith("@") else addr)
while True:
    time.sleep(3600)
PY
# Fake lego: a self-signed certificate for both names where lego puts it.
docker exec -i "$name" tee /src/lego >/dev/null <<'LEGO'
#!/bin/sh
set -eu
path=""; prev=""
for a in "$@"; do [ "$prev" = "--path" ] && path=$a; prev=$a; done
[ -n "${CLOUDFLARE_DNS_API_TOKEN_FILE:-}" ] && [ -s "$CLOUDFLARE_DNS_API_TOKEN_FILE" ] || { echo "no token file" >&2; exit 1; }
mkdir -p "$path/certificates"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 90 -subj "/CN=*.renoxium.test" \
  -addext "subjectAltName=DNS:*.renoxium.test,DNS:renoxium.test" \
  -keyout "$path/certificates/_.renoxium.test.key" -out "$path/certificates/_.renoxium.test.crt" 2>/dev/null
LEGO
docker exec "$name" chmod 0755 /src/cloudflared /src/lego
docker exec "$name" mv /etc/renox/worker.toml /src/local-worker.toml
single() {
  docker exec "$name" /src/ops/scripts/bootstrap-node.sh --single-host --no-enable --worker-version 0.0.2 --worker-bin /src/renox-worker \
    --cloudflared-bin /src/cloudflared --lego-bin /src/lego --node-id node-single --node-token-file /src/node.token "${lsbin[@]}" "$@"
}
if single --control-url https://10.0.1.5:8788 --blocked-addresses 203.0.113.10,127.0.0.1 2>"$ctx/err"; then fail "--single-host refuses a control URL that is not loopback"
elif grep -q "node listener on loopback" "$ctx/err"; then pass "--single-host refuses a control URL that is not the loopback node listener"
else fail "--single-host refuses a non-loopback control URL: $(cat "$ctx/err")"; fi
if single --control-url http://127.0.0.1:8788 --blocked-addresses 203.0.113.10 2>"$ctx/err"; then fail "--single-host needs 127.0.0.1 blocked"
elif grep -q "must list 127.0.0.1" "$ctx/err"; then pass "--single-host refuses a blocklist without the control plane's node listener"
else fail "--single-host needs 127.0.0.1 blocked: $(cat "$ctx/err")"; fi
if single --control-url http://127.0.0.1:8788 --blocked-addresses 127.0.0.1,10.0.1.5 2>"$ctx/err"; then fail "--single-host needs a public address"
elif grep -q "public address" "$ctx/err"; then pass "--single-host refuses a blocklist without the node's public address"
else fail "--single-host needs a public address: $(cat "$ctx/err")"; fi
if docker exec "$name" test -e /etc/renox/worker.toml; then fail "a refused run writes no worker.toml"; else pass "a refused run writes no worker.toml"; fi
if single --control-url http://127.0.0.1:8788 --blocked-addresses 203.0.113.10,2001:db8::10,127.0.0.1 >/dev/null 2>"$ctx/err"; then
  pass "--single-host installs the node"
else fail "--single-host installs the node: $(cat "$ctx/err")"; fi
toml=$(docker exec "$name" cat /etc/renox/worker.toml)
grep -q '^url = "http://127.0.0.1:8788"$' <<< "$toml" && pass "worker.toml: [control] url is the loopback node listener" || fail "worker.toml control url"
grep -q '^fetch_blocked_addresses = \["203.0.113.10", "2001:db8::10", "127.0.0.1"\]$' <<< "$toml" && pass "worker.toml: fetch_blocked_addresses lists the public addresses and 127.0.0.1" || fail "worker.toml blocked addresses"
grep -q '^mode = "controlled"$' <<< "$toml" && grep -A1 '^\[sandbox\]$' <<< "$toml" | grep -q '^enabled = true$' && pass "worker.toml: controlled mode with the sandbox on" || fail "worker.toml mode and sandbox"
docker exec "$name" cp /etc/renox/worker.toml /src/single-worker.toml
if [[ ${RENOX_TEST_STUB_WORKER:-0} != 1 ]]; then
  # The real parser: a config error is logged as "config" before anything else runs.
  docker exec "$name" /opt/renox/bin/renox-worker --sandbox-selftest --config /src/single-worker.toml >"$ctx/out" 2>&1 || true
  if grep -q '"config"' "$ctx/out"; then fail "renox-worker accepts the single-host worker.toml: $(cat "$ctx/out")"; else pass "renox-worker accepts the single-host worker.toml"; fi
else
  echo "skip renox-worker config parse (RENOX_TEST_STUB_WORKER=1)"
fi
for f in cloudflared lego renew-wildcard-cert.sh backup-control-db.sh; do
  if docker exec "$name" test -x "/opt/renox/bin/$f"; then pass "/opt/renox/bin/$f installed"; else fail "/opt/renox/bin/$f installed"; fi
done
modes=$(docker exec "$name" stat -c '%n %a %U' /etc/renox/control.env /etc/renox/secrets /etc/renox/single-host.env /etc/renox/tunnel/config.yml)
grep -q '^/etc/renox/control.env 600 root$' <<< "$modes" && grep -q '^/etc/renox/secrets 700 root$' <<< "$modes" && pass "control.env is 0600 root, secrets/ is 0700 root" || fail "modes: $modes"
if docker exec "$name" id -u renox-control >/dev/null 2>&1; then pass "the renox-control user exists"; else fail "the renox-control user exists"; fi
if docker exec "$name" sh -c 'ls /etc/systemd/system | grep -q "\.example$"'; then fail "no template is installed as a unit"; else pass "no *.example lands in /etc/systemd/system"; fi
# renox-control.service is verified in 5c, once Bun is in place.
units="renox-tunnel.service renox-cert-renew.service renox-cert-renew.timer renox-backup-db.service renox-backup-db.timer"
# shellcheck disable=SC2086
if docker exec "$name" sh -c "cd /etc/systemd/system && systemd-analyze verify $units" 2>"$ctx/err"; then pass "the single-host units verify where they are installed"
else fail "the single-host units verify: $(cat "$ctx/err")"; fi
# A second run changes no template the owner filled in.
docker exec "$name" sh -c 'echo "# filled in" >> /etc/renox/control.env'
single --control-url http://127.0.0.1:8788 --blocked-addresses 203.0.113.10,127.0.0.1 >/dev/null 2>&1 || true
if docker exec "$name" grep -q "# filled in" /etc/renox/control.env; then pass "a second run leaves control.env as the owner wrote it"; else fail "a second run leaves control.env"; fi
# Back to the local-mode worker so it runs without a control plane.
docker exec "$name" sh -c 'mv /src/local-worker.toml /etc/renox/worker.toml && systemctl restart renox-worker'

# Does this container's systemd hand out credentials? (Some nested container
# setups never create /run/credentials/<unit>; a real Ubuntu 24.04 host does.)
docker exec "$name" sh -c 'echo probe > /run/renox-cred-probe && cat > /etc/systemd/system/renox-cred-probe.service <<UNIT
[Service]
Type=oneshot
LoadCredential=probe:/run/renox-cred-probe
ExecStart=/bin/test -s %d/probe
UNIT
systemctl daemon-reload'
if docker exec "$name" systemctl start renox-cred-probe.service >/dev/null 2>&1; then creds=1; else creds=0; fi
docker exec "$name" sh -c 'rm -f /etc/systemd/system/renox-cred-probe.service /run/renox-cred-probe; systemctl daemon-reload'

# 5a. The tunnel: credentials through LoadCredential only.
if [[ $creds == 0 ]]; then
  echo "skip renox-tunnel and renox-cert-renew: this container's systemd does not provide LoadCredential directories"
else
docker exec "$name" sh -c 'echo "{\"AccountTag\":\"test\",\"TunnelSecret\":\"not-a-secret\",\"TunnelID\":\"00000000-0000-0000-0000-000000000000\"}" > /etc/renox/tunnel/credentials.json && chmod 0600 /etc/renox/tunnel/credentials.json'
if docker exec "$name" systemctl start renox-tunnel.service 2>"$ctx/err"; then
  sleep 1
  line=$(docker exec "$name" journalctl -u renox-tunnel --no-pager -o cat | grep fake-cloudflared | tail -n 1)
  if [[ $line == *"credentials=True direct_read=False"* && $line != *"uid=0 "* ]]; then pass "renox-tunnel: config and credentials arrive by LoadCredential; its user cannot read the file itself ($line)"
  else fail "renox-tunnel credentials: $line"; fi
else fail "renox-tunnel starts: $(cat "$ctx/err")"; docker exec "$name" journalctl -u renox-tunnel --no-pager -n 20 >&2 || true; fi
docker exec "$name" systemctl stop renox-tunnel.service || true

# 5b. The certificate: a fake lego, the token by LoadCredential, the worker reloaded.
docker exec "$name" sh -c 'printf "RENOX_APP_DOMAIN=renoxium.test\nRENOX_ACME_EMAIL=ops@renoxium.test\n" > /etc/renox/single-host.env && echo test-token > /etc/renox/secrets/cloudflare-dns.token && chmod 0600 /etc/renox/secrets/cloudflare-dns.token'
pid_before=$(docker exec "$name" systemctl show -p MainPID --value renox-worker)
if docker exec "$name" systemctl start renox-cert-renew.service 2>"$ctx/err"; then
  out=$(docker exec "$name" journalctl -u renox-cert-renew --no-pager -o cat)
  if docker exec "$name" test -s /var/lib/renox/data/_certs/_wildcard.renoxium.test/fullchain.pem && docker exec "$name" test -s /var/lib/renox/data/_certs/renoxium.test/privkey.pem && grep -q "worker reloaded" <<< "$out"; then
    pass "renox-cert-renew installs the certificate into cert_dir and reloads the worker"
  else fail "renox-cert-renew: $out"; fi
  if grep -q test-token <<< "$out"; then fail "the DNS token never reaches the journal"; else pass "the DNS token never reaches the journal"; fi
else fail "renox-cert-renew runs: $(cat "$ctx/err")"; docker exec "$name" journalctl -u renox-cert-renew --no-pager -n 30 >&2 || true; fi
sleep 1
if [[ $(docker exec "$name" systemctl is-active renox-worker || true) == active && $(docker exec "$name" systemctl show -p MainPID --value renox-worker) == "$pid_before" ]]; then
  pass "the worker survives the reload (same PID, still active)"
else fail "the worker survives the reload"; fi

fi

# 5c. The control API under its unit, when Bun and node_modules are here.
bun_bin=${RENOX_BUN_BIN:-$(command -v bun || true)}
repo=$(cd "$here/.." && pwd)
if [[ -n $bun_bin && -x $bun_bin && -d $repo/node_modules ]]; then
  # The checkout the runbook puts at /opt/renox/src: the tracked files and the installed node_modules.
  docker exec "$name" install -d -m 0755 /opt/renox/src
  (cd "$repo" && { git ls-files -z 2>/dev/null; find . -path ./target -prune -o -name node_modules -prune -print0; } | tar --null -T - -cf -) | docker exec -i "$name" tar -xf - -C /opt/renox/src
  docker exec "$name" chown -R root:root /opt/renox/src
  docker cp "$bun_bin" "$name:/opt/renox/bin/bun"
  if docker exec "$name" systemd-analyze verify /etc/systemd/system/renox-control.service 2>"$ctx/err"; then pass "renox-control.service verifies where it is installed"; else fail "renox-control.service verifies: $(cat "$ctx/err")"; fi
  docker exec "$name" sh -c 'cat > /etc/renox/control.env <<ENV
CONTROL_DATABASE_URL=pglite:memory
CONTROL_LISTEN_HOST=127.0.0.1
CONTROL_LISTEN_PORT=8787
CONTROL_NODE_LISTEN_HOST=127.0.0.1
CONTROL_NODE_LISTEN_PORT=8788
CONTROL_TRUSTED_PROXIES=127.0.0.1,::1
ENV
chmod 0600 /etc/renox/control.env'
  docker exec "$name" systemctl start renox-control.service
  up=0
  for _ in $(seq 60); do
    if docker exec "$name" curl -fsS -o /dev/null http://127.0.0.1:8787/v1/healthz 2>/dev/null; then up=1; break; fi
    sleep 1
  done
  if [[ $up == 1 ]]; then pass "renox-control.service serves /v1/healthz on 127.0.0.1:8787"; else fail "renox-control.service starts"; docker exec "$name" journalctl -u renox-control --no-pager -n 30 >&2 || true; fi
  listening=$(docker exec "$name" ss -Htln)
  if grep -Eq '127\.0\.0\.1:8787 ' <<< "$listening" && grep -Eq '127\.0\.0\.1:8788 ' <<< "$listening" && ! grep -Eq '(0\.0\.0\.0|\*|\[::\]):878[78] ' <<< "$listening"; then
    pass "both control listeners are on loopback only"
  else fail "control listeners: $listening"; fi
  if docker exec "$name" su -s /bin/sh renox-control -c 'cat /etc/renox/control.env' >/dev/null 2>&1; then fail "the service user cannot read control.env"; else pass "the service user cannot read control.env (systemd reads it as root)"; fi
  docker exec "$name" sh -c 'sed -i "s/^CONTROL_LISTEN_HOST=.*/CONTROL_LISTEN_HOST=0.0.0.0/" /etc/renox/control.env && systemctl restart renox-control.service' || true
  sleep 5
  if [[ $(docker exec "$name" systemctl is-active renox-control || true) != active ]] && docker exec "$name" journalctl -u renox-control --no-pager -o cat | grep -q "CONTROL_LISTEN_HOST 0.0.0.0 is not a loopback address" && [[ $(docker exec "$name" systemctl show -p ExecMainStatus --value renox-control) == 78 ]]; then
    pass "renox-control refuses 0.0.0.0 behind loopback-only proxies"
  else
    fail "renox-control refuses 0.0.0.0 ($(docker exec "$name" systemctl is-active renox-control || true))"
    docker exec "$name" journalctl -u renox-control --no-pager -o cat -n 15 >&2 || true
  fi
  docker exec "$name" systemctl stop renox-control.service || true
else
  echo "skip renox-control.service: no Bun (RENOX_BUN_BIN) or no node_modules in $repo"
fi

if [[ $failures -ne 0 ]]; then echo "$failures failed" >&2; exit 1; fi
echo "all passed"
