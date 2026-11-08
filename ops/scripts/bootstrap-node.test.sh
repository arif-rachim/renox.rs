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
# The single host (#366, #420, tunnel-only since ADR D25): `--single-host`
# with a fake cloudflared binary; the worker.toml it writes (the unix listen
# socket, cloudflared's user trusted, control URL on loopback, the blocked
# addresses, the sandbox), its refusals, the files, users, groups and modes it
# installs (renox-tunnel in renox-edge, /run/renox-edge by tmpfiles);
# renox-tunnel.service runs as renox-tunnel and gets its config and
# credentials through LoadCredential and cannot read the root-only file
# itself; renox-control.service (when Bun and the repository's node_modules
# are on this machine: RENOX_BUN_BIN, default `bun` on PATH) listens on
# 127.0.0.1 only and refuses 0.0.0.0 behind loopback proxies. HOST-OPS:
# node.token and platform.key are renox:renox 0400 and the real single-host
# worker (controlled, sandbox on) starts with them, listens on
# /run/renox-edge/worker.sock (renox:renox-edge 0660) and on no TCP port, and
# holds no capability (#393, #414, #420); renox-backup-db.service runs as
# postgres with its LoadCredential copy (#395); production-install.test.sh,
# when Bun is on this machine (#400).
# Threat-model rows (docs/24-threat-model.md): "Isolate escape (V8 bug)", the
# systemd layer (the worker and renox-child@ hold no capability); "Key
# compromise", the node token and page session key readable by renox only;
# "Local process forges the client-IP header", the socket's group and mode;
# "Secrets in logs, errors, bundle, responses", the R2 secret never in a
# unit's journal; "Tenant files or backups read from storage", the
# control-database backup encrypted to the age public key through its real
# unit.
# RENOX_TEST_STUB_WORKER=1 says the worker binary is a stand-in (a local run
# without a build), so the real config parser is not asked.
# RENOX_TEST_FORCE_UPGRADE_FAILURE=1 makes the second --upgrade run of step 4
# fail (a --worker-bin that does not exist), to see what a failure prints and
# that step 5 does not inherit it (#464).
#
# #464, the intermittent step 4 in CI (run 42041215973, 18 s then FAIL, and
# step 5 refused for "this node runs renox-worker 0.0.1"): the version file
# still said 0.0.1, so the first `--upgrade` run (same version) failed after
# it wrote the file, and the second never ran. Its output went to /dev/null.
# Every bootstrap run downloaded Litestream from GitHub again (curl --retry 3:
# about 7 s of back-off plus the attempts), five times per test, and a failed
# download fits both the 18 s and the missing message. Now only step 1
# downloads it (the fetch path stays tested); later runs install the binary
# step 1 verified and installed. Every bootstrap run's output is kept and
# printed on failure with `systemctl status` and the worker's journal; the
# worker is awaited (`systemctl is-active` polled) instead of a fixed sleep;
# the single-host runs pass --upgrade, so step 5 starts from a known state
# whatever step 4 left.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
worker=${1:-}
[[ -n $worker && -f $worker ]] || { echo "usage: $0 <path to renox-worker>" >&2; exit 2; }

skip() { echo "SKIP bootstrap-node container test: $*"; exit 0; }
command -v docker >/dev/null 2>&1 || skip "docker is not installed"
docker info >/dev/null 2>&1 || skip "no docker daemon reachable"

# The tag names the package list: a new list gets a new tag, so a cached image
# without the new packages is never reused.
image=renox-bootstrap-test:24.04-age
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
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv curl ca-certificates python3 openssl iproute2 age \
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
# Two differences between a container and the Ubuntu 24.04 host, undone so
# the test sees what the host does:
# - Docker sets net.ipv4.ip_unprivileged_port_start to 0 in the container's
#   network namespace; Ubuntu keeps 1024. The worker binds no TCP port below
#   it since #420 (a unix socket), so it needs no capability for that.
# - The container's / is a private mount, so systemd's credential directories
#   (LoadCredential) never appear under /run/credentials; on the host / is
#   shared (#395).
docker exec "$name" sysctl -qw net.ipv4.ip_unprivileged_port_start=1024
docker exec "$name" mount --make-rshared /

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
# What a failed bootstrap run said, and the worker's state (#464).
explain() {
  local what=$1 log=$2
  {
    echo "---- $what: output"
    cat "$log" 2>/dev/null || true
    echo "---- systemctl status renox-worker"
    docker exec "$name" systemctl status renox-worker --no-pager --lines=0 2>&1 || true
    echo "---- journalctl -u renox-worker (last 30 lines)"
    docker exec "$name" journalctl -u renox-worker --no-pager -n 30 2>&1 || true
    echo "----"
  } >&2
}
# Polls until the worker is active (the unit is Type=exec: `restart` returns
# once the process is exec'd, not when it serves).
worker_active() {
  local state=""
  for _ in $(seq 20); do
    state=$(docker exec "$name" systemctl is-active renox-worker 2>/dev/null || true)
    [[ $state == active ]] && return 0
    sleep 0.5
  done
  return 1
}

# RENOX_TEST_LITESTREAM_BIN: a Litestream binary to install instead of fetching
# it (a local run whose container has no route to GitHub).
lsbin=()
if [[ -n ${RENOX_TEST_LITESTREAM_BIN:-} ]]; then
  docker cp "$RENOX_TEST_LITESTREAM_BIN" "$name:/src/litestream"
  lsbin=(--litestream-bin /src/litestream)
fi
boot() { docker exec "$name" /src/ops/scripts/bootstrap-node.sh --worker-version 0.0.1 --worker-bin /src/renox-worker --config /src/worker.toml "${lsbin[@]}" "$@"; }

# 1. Install without starting, then add the (empty) route table the local mode needs.
if boot --no-enable >"$ctx/boot1" 2>&1; then pass "bootstrap installs the node (--no-enable)"; else
  fail "bootstrap installs the node (--no-enable)"
  explain "bootstrap --no-enable" "$ctx/boot1"
fi
docker exec "$name" sh -c 'echo "{\"version\": 0, \"entries\": []}" > /var/lib/renox/data/routes.json && chown renox:renox /var/lib/renox/data/routes.json'
# Step 1 fetched and verified the pinned Litestream (fetch-litestream.sh);
# every later run installs that binary instead of downloading it again (#464).
if [[ ${#lsbin[@]} -eq 0 ]] && docker exec "$name" cp /opt/renox/bin/litestream /src/litestream 2>/dev/null; then
  lsbin=(--litestream-bin /src/litestream)
fi

# 2. Second run, same version: enables and starts the target.
if boot >"$ctx/boot2" 2>&1; then pass "a second run with the same version succeeds and starts the node"; else
  fail "a second run with the same version succeeds"
  explain "bootstrap (second run)" "$ctx/boot2"
fi
worker_active || true
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
# Each run's output is kept: a failure names the run and shows what it said,
# `systemctl status` and the worker's journal (#464).
upgrade_bin=/src/renox-worker
[[ ${RENOX_TEST_FORCE_UPGRADE_FAILURE:-0} == 1 ]] && upgrade_bin=/src/no-such-renox-worker
if ! boot --upgrade >"$ctx/up1" 2>&1; then
  fail "--upgrade installs the new version: the --upgrade run with the same version (0.0.1) failed"
  explain "bootstrap --worker-version 0.0.1 --upgrade" "$ctx/up1"
elif ! docker exec "$name" /src/ops/scripts/bootstrap-node.sh --worker-version 0.0.2 --worker-bin "$upgrade_bin" --config /src/worker.toml "${lsbin[@]}" --upgrade >"$ctx/up2" 2>&1; then
  fail "--upgrade installs the new version: the --upgrade run to 0.0.2 failed"
  explain "bootstrap --worker-version 0.0.2 --upgrade" "$ctx/up2"
elif [[ $(docker exec "$name" cat /opt/renox/worker-version) == 0.0.2 ]] && worker_active; then
  pass "--upgrade installs the new version and the worker restarts"
else
  fail "--upgrade installs the new version and the worker restarts (version $(docker exec "$name" cat /opt/renox/worker-version 2>&1))"
  explain "bootstrap --worker-version 0.0.2 --upgrade" "$ctx/up2"
fi

# 5. The single host (#366). The local-mode worker.toml is set aside so the
# bootstrap writes the single-host one, then put back for the worker to run.
# A token of the right shape (renox_node_ + 32 base32 characters) that no
# control plane ever issued: the worker reads it at start (#393).
docker exec "$name" sh -c 'printf "renox_node_%s\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > /src/node.token && chmod 0600 /src/node.token'
# Fake cloudflared: proves it got both files through LoadCredential and that
# its user (renox-tunnel) cannot read the root-only credentials file directly;
# then tells systemd it is ready, as the real one does.
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
docker exec "$name" chmod 0755 /src/cloudflared
docker exec "$name" mv /etc/renox/worker.toml /src/local-worker.toml
# --upgrade: step 5 installs 0.0.2 whatever version step 4 left (#464), so it
# passes or fails on its own merits.
single() {
  docker exec "$name" /src/ops/scripts/bootstrap-node.sh --single-host --no-enable --upgrade --worker-version 0.0.2 --worker-bin /src/renox-worker \
    --cloudflared-bin /src/cloudflared --node-id node-single --node-token-file /src/node.token "${lsbin[@]}" "$@"
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
# #544: this image has age but neither sqlite3 nor pg_dump; the run warns and goes on.
if grep -q 'warning: missing commands the single-host units need: sqlite3 pg_dump ' "$ctx/err"; then pass "--single-host warns about the missing sqlite3 and pg_dump"
else fail "--single-host warns about missing commands: $(cat "$ctx/err")"; fi
toml=$(docker exec "$name" cat /etc/renox/worker.toml)
grep -q '^url = "http://127.0.0.1:8788"$' <<< "$toml" && pass "worker.toml: [control] url is the loopback node listener" || fail "worker.toml control url"
grep -q '^fetch_blocked_addresses = \["203.0.113.10", "2001:db8::10", "127.0.0.1"\]$' <<< "$toml" && pass "worker.toml: fetch_blocked_addresses lists the public addresses and 127.0.0.1" || fail "worker.toml blocked addresses"
grep -q '^mode = "controlled"$' <<< "$toml" && grep -A1 '^\[sandbox\]$' <<< "$toml" | grep -q '^enabled = true$' && pass "worker.toml: controlled mode with the sandbox on" || fail "worker.toml mode and sandbox"
# Tunnel-only (#414, #420): the unix socket, cloudflared's user trusted, no [tls].
grep -q '^listen = "unix:/run/renox-edge/worker.sock"$' <<< "$toml" && grep -q '^trusted_socket_users = \["renox-tunnel"\]$' <<< "$toml" \
  && grep -q '^socket_group = "renox-edge"$' <<< "$toml" && ! grep -q '^\[tls\]' <<< "$toml" && pass "worker.toml: the unix socket, renox-tunnel trusted, group renox-edge, no [tls]" || fail "worker.toml listen and trusted peer"
docker exec "$name" cp /etc/renox/worker.toml /src/single-worker.toml
if [[ ${RENOX_TEST_STUB_WORKER:-0} != 1 ]]; then
  # The real parser: a config error is logged as "config" before anything else runs.
  docker exec "$name" /opt/renox/bin/renox-worker --sandbox-selftest --config /src/single-worker.toml >"$ctx/out" 2>&1 || true
  if grep -q '"config"' "$ctx/out"; then fail "renox-worker accepts the single-host worker.toml: $(cat "$ctx/out")"; else pass "renox-worker accepts the single-host worker.toml"; fi
else
  echo "skip renox-worker config parse (RENOX_TEST_STUB_WORKER=1)"
fi
for f in cloudflared backup-control-db.sh renox-alert.sh; do
  if docker exec "$name" test -x "/opt/renox/bin/$f"; then pass "/opt/renox/bin/$f installed"; else fail "/opt/renox/bin/$f installed"; fi
done
modes=$(docker exec "$name" stat -c '%n %a %U' /etc/renox/control.env /etc/renox/secrets /etc/renox/tunnel/config.yml)
grep -q '^/etc/renox/control.env 600 root$' <<< "$modes" && grep -q '^/etc/renox/secrets 700 root$' <<< "$modes" && pass "control.env is 0600 root, secrets/ is 0700 root" || fail "modes: $modes"
if docker exec "$name" id -u renox-control >/dev/null 2>&1; then pass "the renox-control user exists"; else fail "the renox-control user exists"; fi
# #414, #420: cloudflared's static user in the socket's group; the socket's directory by tmpfiles.
if [[ $(docker exec "$name" id -gn renox-tunnel 2>&1 || true) == renox-edge ]]; then pass "renox-tunnel exists, primary group renox-edge"; else fail "the renox-tunnel user"; fi
if docker exec "$name" grep -qx 'd /run/renox-edge 0750 renox renox-edge -' /etc/tmpfiles.d/renox-edge.conf; then pass "/run/renox-edge comes from tmpfiles (renox:renox-edge 0750)"; else fail "the tmpfiles entry of /run/renox-edge"; fi
edge=$(docker exec "$name" stat -c '%U:%G %a' /run/renox-edge 2>&1 || true)
if [[ $edge == "renox:renox-edge 750" ]]; then pass "/run/renox-edge is renox:renox-edge 0750"; else fail "/run/renox-edge: $edge"; fi
if docker exec "$name" grep -q '^CONTROL_CF_FALLBACK_ORIGIN=renoxium.app$' /etc/renox/control.env && ! docker exec "$name" grep -q 'CONTROL_ACME\|CONTROL_DNS_SERVERS\|CONTROL_EDGE' /etc/renox/control.env; then
  pass "control.env: CONTROL_CF_* (#419), no ACME, DNS or edge-address settings"
else fail "control.env Cloudflare settings"; fi
if docker exec "$name" test -e /var/lib/renox-acme-challenges || docker exec "$name" test -e /opt/renox/bin/lego; then fail "no ACME directory and no lego (ADR D25)"; else pass "no ACME directory and no lego (ADR D25)"; fi
# #393: the worker runs as renox and refuses any group or other bit.
keys=$(docker exec "$name" stat -c '%n %U:%G %a' /etc/renox/node.token /etc/renox/platform.key 2>&1 || true)
if grep -q '^/etc/renox/node.token renox:renox 400$' <<< "$keys" && grep -q '^/etc/renox/platform.key renox:renox 400$' <<< "$keys"; then
  pass "node.token and platform.key are renox:renox 0400"
else fail "node.token and platform.key modes: $keys"; fi
if docker exec "$name" sh -c 'ls /etc/systemd/system | grep -q "\.example$"'; then fail "no template is installed as a unit"; else pass "no *.example lands in /etc/systemd/system"; fi
# renox-control.service is verified in 5c, once Bun is in place.
units="renox-tunnel.service renox-backup-db.service renox-backup-db.timer"
# shellcheck disable=SC2086
if docker exec "$name" sh -c "cd /etc/systemd/system && systemd-analyze verify $units" 2>"$ctx/err"; then pass "the single-host units verify where they are installed"
else fail "the single-host units verify: $(cat "$ctx/err")"; fi
# A second run changes no template the owner filled in, and corrects the
# key files an older bootstrap installed root:renox 0640 (#393) without
# touching their content.
docker exec "$name" sh -c 'echo "# filled in" >> /etc/renox/control.env'
sum_before=$(docker exec "$name" sha256sum /etc/renox/platform.key || true)
docker exec "$name" sh -c 'chown root:renox /etc/renox/node.token /etc/renox/platform.key && chmod 0640 /etc/renox/node.token /etc/renox/platform.key'
single --control-url http://127.0.0.1:8788 --blocked-addresses 203.0.113.10,127.0.0.1 >/dev/null 2>&1 || true
if docker exec "$name" grep -q "# filled in" /etc/renox/control.env; then pass "a second run leaves control.env as the owner wrote it"; else fail "a second run leaves control.env"; fi
keys=$(docker exec "$name" stat -c '%U:%G %a' /etc/renox/node.token /etc/renox/platform.key 2>&1 | sort -u || true)
if [[ $keys == "renox:renox 400" && $(docker exec "$name" sha256sum /etc/renox/platform.key) == "$sum_before" ]]; then
  pass "a second run corrects 0640 key files to renox:renox 0400 and keeps the platform key"
else fail "a second run corrects the key files: $keys"; fi

# 5-worker. The single-host worker as installed (#393, #414, #420): controlled
# mode, the sandbox on, the installed node.token and platform.key, the unix
# socket behind cloudflared and no TCP port. No control plane answers, so the
# worker runs degraded; it must still start and listen.
if [[ ${RENOX_TEST_STUB_WORKER:-0} != 1 ]]; then
  docker exec "$name" systemctl restart renox-worker
  sleep 4
  journal=$(docker exec "$name" journalctl -u renox-worker --no-pager -o cat -n 200 || true)
  if [[ $(docker exec "$name" systemctl is-active renox-worker || true) == active ]] && grep -q '"controlled":true' <<< "$journal"; then
    pass "renox-worker starts in controlled mode with the installed worker.toml, node.token and platform.key"
  else fail "renox-worker starts with the installed files: $(tail -n 5 <<< "$journal")"; fi
  if grep -Eq 'must be 0600|node token file|platform key file' <<< "$journal"; then fail "the worker accepts the installed key files"; else pass "the worker accepts the installed key files (no mode error)"; fi
  sock=$(docker exec "$name" stat -c '%F %U:%G %a' /run/renox-edge/worker.sock 2>&1 || true)
  if [[ $sock == "socket renox:renox-edge 660" ]]; then pass "renox-worker listens on /run/renox-edge/worker.sock (renox:renox-edge 0660)"
  else fail "the worker socket: $sock $(grep -m1 -i 'listen\|bind' <<< "$journal")"; fi
  tcp=$(docker exec "$name" ss -Htlnp 2>/dev/null | grep renox-worker | grep -Ev '127\.0\.0\.1:9090 ' || true)
  if [[ -z $tcp ]]; then pass "renox-worker listens on no public TCP port (no 80, no 443)"; else fail "renox-worker TCP listeners: $tcp"; fi
  worker_pid=$(docker exec "$name" systemctl show -p MainPID --value renox-worker || true)
  caps=$(docker exec "$name" awk '/^Cap(Eff|Bnd)/ { print $2 }' "/proc/$worker_pid/status" 2>&1 | sort -u || true)
  if [[ $caps == 0000000000000000 ]]; then pass "the worker holds no capability (effective and bounding)"; else fail "worker capabilities: $caps"; fi
else
  echo "skip the single-host worker start (RENOX_TEST_STUB_WORKER=1)"
fi
child_caps=$(docker exec "$name" systemctl show -p AmbientCapabilities --value renox-child@t-test.service || true)
if [[ -z $child_caps ]]; then pass "renox-child@ gets no ambient capability"; else fail "renox-child@ ambient capabilities: $child_caps"; fi
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
  echo "skip renox-tunnel: this container's systemd does not provide LoadCredential directories"
else
docker exec "$name" sh -c 'echo "{\"AccountTag\":\"test\",\"TunnelSecret\":\"not-a-secret\",\"TunnelID\":\"00000000-0000-0000-0000-000000000000\"}" > /etc/renox/tunnel/credentials.json && chmod 0600 /etc/renox/tunnel/credentials.json'
if docker exec "$name" systemctl start renox-tunnel.service 2>"$ctx/err"; then
  sleep 1
  line=$(docker exec "$name" journalctl -u renox-tunnel --no-pager -o cat | grep fake-cloudflared | tail -n 1)
  tunnel_uid=$(docker exec "$name" id -u renox-tunnel)
  if [[ $line == *"credentials=True direct_read=False"* && $line == *"uid=$tunnel_uid "* ]]; then pass "renox-tunnel: runs as renox-tunnel; config and credentials arrive by LoadCredential; its user cannot read the file itself ($line)"
  else fail "renox-tunnel credentials: $line"; fi
else fail "renox-tunnel starts: $(cat "$ctx/err")"; docker exec "$name" journalctl -u renox-tunnel --no-pager -n 20 >&2 || true; fi
docker exec "$name" systemctl stop renox-tunnel.service || true

# 5d. The backup through its unit (#395): User=postgres gets the R2 file from
# LoadCredential as root 0440 (systemd 255), which backup-control-db.sh must
# accept there. A fake pg_dump on the unit's PATH and a fake S3 on loopback;
# the drop-in only allows that http:// endpoint (RENOX_BACKUP_ALLOW_HTTP), it
# changes nothing about the credentials.
docker exec "$name" sh -c 'id -u postgres >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin postgres'
docker exec -i "$name" tee /usr/local/bin/pg_dump >/dev/null <<'SH'
#!/bin/sh
printf 'PGDMP fake dump of %s\n' "$*"
SH
docker exec -i "$name" tee /src/s3.py >/dev/null <<'PY'
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
docker exec "$name" sh -c 'chmod 0755 /usr/local/bin/pg_dump && mkdir -p /src/s3-store'
docker exec -d "$name" python3 /src/s3.py /src/s3-store
docker exec "$name" sh -c 'age-keygen -o /src/backup-age.key 2>/dev/null && age-keygen -y /src/backup-age.key > /etc/renox/backup-age.pub && chmod 0644 /etc/renox/backup-age.pub
printf "R2_ENDPOINT=http://127.0.0.1:9599\nR2_BUCKET=renoxium-backups\nR2_ACCESS_KEY_ID=RENOXTESTKEY0000000000001\nR2_SECRET_ACCESS_KEY=test-secret-not-real\n" > /etc/renox/secrets/r2-backup.env
chmod 0600 /etc/renox/secrets/r2-backup.env
mkdir -p /etc/systemd/system/renox-backup-db.service.d
printf "[Service]\nEnvironment=RENOX_BACKUP_ALLOW_HTTP=1\n" > /etc/systemd/system/renox-backup-db.service.d/test-http.conf
systemctl daemon-reload'
if docker exec "$name" systemctl start renox-backup-db.service 2>"$ctx/err"; then
  out=$(docker exec "$name" journalctl -u renox-backup-db --no-pager -o cat)
  obj=$(docker exec "$name" sh -c 'ls /src/s3-store | head -n 1' || true)
  if grep -q "backup-control-db: renox -> renoxium-backups/control-db/" <<< "$out" && [[ -n $obj ]] \
    && docker exec "$name" sh -c "age --decrypt --identity /src/backup-age.key '/src/s3-store/$obj' | grep -q 'PGDMP fake dump of'"; then
    pass "renox-backup-db.service runs as postgres with the R2 file from LoadCredential (systemd's 0440) and uploads a dump that decrypts"
  else fail "renox-backup-db.service: $out"; fi
  if grep -q test-secret-not-real <<< "$out"; then fail "the R2 secret never reaches the journal"; else pass "the R2 secret never reaches the journal"; fi
else fail "renox-backup-db.service runs: $(cat "$ctx/err")"; docker exec "$name" journalctl -u renox-backup-db --no-pager -o cat -n 20 >&2 || true; fi
docker exec "$name" sh -c 'rm -r /etc/systemd/system/renox-backup-db.service.d && systemctl daemon-reload'

fi

# 5c. The control API under its unit, when Bun and node_modules are here.
bun_bin=${RENOX_BUN_BIN:-$(command -v bun || true)}
repo=$(cd "$here/.." && pwd)
# ops/single-host.md step 3 (#400): the production install of the tracked
# files, on this machine (it needs the npm registry).
if [[ -n $bun_bin && -x $bun_bin ]]; then
  if RENOX_BUN_BIN=$bun_bin "$here/scripts/production-install.test.sh" >"$ctx/prod" 2>&1; then
    pass "bun install --frozen-lockfile --production works on the tracked files (production-install.test.sh)"
  else fail "production-install.test.sh: $(grep -E '^(FAIL|SKIP)' "$ctx/prod")"; fi
fi
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
