#!/usr/bin/env bash
# Container test of firewall-single-host.sh (#366): an ubuntu:24.04 container
# with NET_ADMIN (its own network namespace, so the host's firewall is never
# touched) runs the script; a second container on the same network probes it.
#
#   ops/scripts/firewall-single-host.test.sh
#
# Proves: the script refuses without an sshd, with sshd on another port only,
# and from a session on a port it does not open, and leaves no rules behind
# when it refuses; --dry-run loads nothing; once applied, 22, 80 and 443 answer
# from outside while 8787 and 5432 (listening on every interface on purpose)
# do not; a second run is a no-op (same ruleset, one table, one include line);
# --ssh-port opens that port instead of 22 (a bad value is refused, a session
# on 22 is refused, and after the switch 22 is closed from outside).
#
# Skipped (exit 0, with the reason) without a docker daemon. An image that
# already exists under the test's tag is reused (a local build behind a proxy).
set -euo pipefail

# pwd -W (Git Bash on Windows) gives docker cp a path it understands; elsewhere pwd.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })

skip() { echo "SKIP firewall container test: $*"; exit 0; }
command -v docker >/dev/null 2>&1 || skip "docker is not installed"
docker info >/dev/null 2>&1 || skip "no docker daemon reachable"

image=renox-firewall-test:24.04
server=renox-fw-server-$$
client=renox-fw-client-$$
net=renox-fw-net-$$
ctx=$(mktemp -d)
cleanup() {
  docker rm -f "$server" "$client" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$ctx"
}
trap cleanup EXIT

if ! docker image inspect "$image" >/dev/null 2>&1; then
  cat > "$ctx/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nftables iproute2 openssh-server python3 netcat-openbsd \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && ssh-keygen -A
CMD ["sleep", "infinity"]
DOCKERFILE
  docker build --quiet --tag "$image" "$ctx" >/dev/null
fi

docker network create "$net" >/dev/null
docker run --detach --name "$server" --network "$net" --cap-add NET_ADMIN "$image" >/dev/null
docker run --detach --name "$client" --network "$net" "$image" >/dev/null
docker exec "$server" mkdir -p /src
docker cp "$here" "$server:/src/ops"

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; failures=$((failures + 1)); }

on() { docker exec "$server" "$@"; }
# fw [-e NAME=value] [script options]: runs the script in the server container.
fw() {
  local env=()
  if [[ ${1:-} == -e ]]; then env=(-e "$2"); shift 2; fi
  docker exec "${env[@]}" "$server" /src/ops/scripts/firewall-single-host.sh "$@"
}
no_table() { ! on nft list table inet renox_single_host >/dev/null 2>&1; }
reach() { docker exec "$client" nc -z -w 2 "$server" "$1" >/dev/null 2>&1; }
sshd_on() { on pkill -x sshd >/dev/null 2>&1 || true; sleep 0.5; on /usr/sbin/sshd -p "$1"; sleep 0.5; }

# Listeners on every interface, including the two that must stay closed.
for p in 80 443 8787 5432; do
  docker exec --detach "$server" python3 -m http.server --bind 0.0.0.0 "$p" >/dev/null
done
sleep 1

# 1. No sshd: refused, nothing loaded.
if fw 2>"$ctx/err"; then fail "no sshd: refused"; elif grep -q "cannot find an sshd" "$ctx/err" && no_table; then
  pass "no sshd listening: refused, no rules loaded"
else fail "no sshd: refused ($(cat "$ctx/err"))"; fi

# 2. sshd on 2222 only: refused (it would be locked out).
sshd_on 2222
if fw 2>"$ctx/err"; then fail "sshd on 2222: refused"; elif grep -q "would lock SSH out" "$ctx/err" && no_table; then
  pass "sshd on port 2222 only: refused, no rules loaded"
else fail "sshd on 2222: refused ($(cat "$ctx/err"))"; fi

# 3. sshd on 22, but this session arrived on 2200: refused.
sshd_on 22
if fw -e SSH_CONNECTION="198.51.100.7 50000 10.0.0.2 2200" 2>"$ctx/err"; then fail "a session on 2200: refused"
elif grep -q "arrived on port 2200" "$ctx/err" && no_table; then pass "a session on a port the rules do not open: refused"
else fail "a session on 2200: refused ($(cat "$ctx/err"))"; fi
if fw -e SSH_CONNECTION="198.51.100.7 50000 10.0.0.2" 2>"$ctx/err"; then fail "a malformed SSH_CONNECTION: refused"
else pass "a malformed SSH_CONNECTION: refused"; fi

# 4. --dry-run prints the rules and loads nothing.
if out=$(fw --dry-run 2>&1) && grep -q "tcp dport 22 accept" <<< "$out" && no_table; then pass "--dry-run prints the ruleset and loads nothing"
else fail "--dry-run: $out"; fi

# 5. An open SSH connection on 22 and the session's SSH_CONNECTION on 22: applied.
docker exec --detach "$client" sh -c "sleep 30 | nc $server 22" >/dev/null
sleep 1
if fw -e SSH_CONNECTION="198.51.100.7 50000 10.0.0.2 22" >/dev/null 2>"$ctx/err"; then pass "sshd on 22 and the session on 22: applied"
else fail "applied: $(cat "$ctx/err")"; fi
for p in 22 80 443; do
  if reach "$p"; then pass "port $p reachable from outside"; else fail "port $p reachable from outside"; fi
done
for p in 8787 5432; do
  if reach "$p"; then fail "port $p closed from outside"; else pass "port $p closed from outside (listener on 0.0.0.0)"; fi
done
if on sh -c 'nc -z -w 2 127.0.0.1 8787 2>/dev/null'; then pass "loopback still reaches 8787 (cloudflared's path)"; else fail "loopback reaches 8787"; fi

# 6. A second run: same ruleset, one table, one include line.
before=$(on nft list ruleset 2>/dev/null | sha256sum)
if fw >/dev/null 2>&1; then pass "a second run succeeds"; else fail "a second run succeeds"; fi
after=$(on nft list ruleset 2>/dev/null | sha256sum)
if [[ $before == "$after" ]]; then pass "a second run leaves the same ruleset"; else fail "a second run leaves the same ruleset"; fi
tables=$(on nft list tables | grep -c renox_single_host || true)
includes=$(on grep -c 'renox-single-host.nft' /etc/nftables.conf || true)
if [[ $tables == 1 && $includes == 1 ]]; then pass "one table, one include line in /etc/nftables.conf"; else fail "one table ($tables), one include ($includes)"; fi
if on nft -c -f /etc/nftables.d/renox-single-host.nft; then pass "the persisted file parses"; else fail "the persisted file parses"; fi

# 7. --ssh-port: sshd on 49222 only, the session on 49222.
docker exec "$client" pkill -x nc >/dev/null 2>&1 || true
before=$(on nft list ruleset 2>/dev/null | sha256sum)
for bad in 0 65536 abc "" 443; do
  if fw --ssh-port "$bad" >/dev/null 2>"$ctx/err"; then fail "--ssh-port '$bad': refused"
  elif grep -q "ssh-port" "$ctx/err"; then pass "--ssh-port '$bad': refused"
  else fail "--ssh-port '$bad': refused ($(cat "$ctx/err"))"; fi
done
after=$(on nft list ruleset 2>/dev/null | sha256sum)
if [[ $before == "$after" ]]; then pass "a refused --ssh-port leaves the ruleset alone"; else fail "a refused --ssh-port leaves the ruleset alone"; fi
sshd_on 49222
if fw -e SSH_CONNECTION="198.51.100.7 50000 10.0.0.2 22" --ssh-port 49222 >/dev/null 2>"$ctx/err"; then fail "--ssh-port 49222 from a session on 22: refused"
elif grep -q "arrived on port 22" "$ctx/err"; then pass "--ssh-port 49222 from a session on 22: refused"
else fail "--ssh-port 49222 from a session on 22: refused ($(cat "$ctx/err"))"; fi
if fw -e SSH_CONNECTION="198.51.100.7 50000 10.0.0.2 49222" --ssh-port 49222 >/dev/null 2>"$ctx/err"; then pass "sshd on 49222, --ssh-port 49222 and the session on 49222: applied"
else fail "--ssh-port 49222 applied: $(cat "$ctx/err")"; fi
if reach 49222; then pass "port 49222 reachable from outside"; else fail "port 49222 reachable from outside"; fi
if reach 22; then fail "port 22 closed from outside after --ssh-port 49222"; else pass "port 22 closed from outside after --ssh-port 49222"; fi
for p in 80 443; do
  if reach "$p"; then pass "port $p still reachable with --ssh-port 49222"; else fail "port $p still reachable with --ssh-port 49222"; fi
done
if on grep -q 'tcp dport 49222 accept' /etc/nftables.d/renox-single-host.nft; then pass "the persisted file carries port 49222"; else fail "the persisted file carries port 49222"; fi

if [[ $failures -ne 0 ]]; then echo "$failures failed" >&2; exit 1; fi
echo "all passed"
