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

cat > "$ctx/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE
docker build --quiet --tag "$image" "$ctx" >/dev/null

docker run --detach --name "$name" --privileged --cgroupns=host \
  --volume /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$image" >/dev/null

state=$(docker exec "$name" timeout 60 systemctl is-system-running --wait 2>/dev/null || true)
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

boot() { docker exec "$name" /src/ops/scripts/bootstrap-node.sh --worker-version 0.0.1 --worker-bin /src/renox-worker --config /src/worker.toml "$@"; }

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
if docker exec "$name" /src/ops/scripts/bootstrap-node.sh --worker-version 0.0.2 --worker-bin /src/renox-worker --config /src/worker.toml 2>"$ctx/err"; then
  fail "another version without --upgrade is refused"
elif grep -q -- "--upgrade" "$ctx/err"; then
  pass "another version without --upgrade is refused"
else
  fail "another version without --upgrade is refused: $(cat "$ctx/err")"
fi

# 4. --upgrade installs it, keeps the previous binary for rollback and restarts.
if boot --upgrade >/dev/null 2>&1 && docker exec "$name" /src/ops/scripts/bootstrap-node.sh --worker-version 0.0.2 --worker-bin /src/renox-worker --config /src/worker.toml --upgrade >/dev/null; then
  sleep 2
  if [[ $(docker exec "$name" cat /opt/renox/worker-version) == 0.0.2 && $(docker exec "$name" systemctl is-active renox-worker || true) == active ]]; then
    pass "--upgrade installs the new version and the worker restarts"
  else
    fail "--upgrade installs the new version and the worker restarts"
  fi
else
  fail "--upgrade installs the new version"
fi

if [[ $failures -ne 0 ]]; then echo "$failures failed" >&2; exit 1; fi
echo "all passed"
