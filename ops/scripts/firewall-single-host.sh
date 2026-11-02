#!/usr/bin/env bash
# The single host's inbound firewall (#366, ops/single-host.md): nftables,
# inbound TCP 22, 80 and 443 only (plus loopback, replies to our own
# connections, and the ICMP that IPv4 and IPv6 need). Postgres (5432) and the
# control API (8787, 8788) listen on loopback and are never reachable from
# outside even if a listener is misconfigured. Outbound is not restricted:
# the tunnel, R2, ACME and the mail provider are reached from here.
#
#   sudo ops/scripts/firewall-single-host.sh [--dry-run] [--no-ssh] [--ssh-port <n>]
#
# The SSH port (22, or --ssh-port when sshd runs elsewhere) is always open;
# nothing this script writes can close it. Before it changes anything it
# checks that the SSH server and the session running it stay reachable, and
# refuses otherwise:
#   - sshd must listen on the SSH port (a server on another port only would
#     be locked out; pass that port with --ssh-port, or move sshd);
#   - the session the script runs in (SSH_CONNECTION, or every established
#     connection of an sshd process when sudo dropped that variable) must
#     have arrived on the SSH port;
#   - when no sshd runs at all, it refuses unless --no-ssh says that is
#     intended (a console-only host).
# After loading the rules it reads them back and removes its table again if
# the SSH port rule is not there. Only one SSH port is opened: a second run
# with another --ssh-port replaces the rule, so run it from a session on the
# new port.
#
# Idempotent: the rules live in their own table, `inet renox_single_host`,
# which each run replaces atomically (one `nft -f` transaction); other tables
# are not touched. The ruleset is written to /etc/nftables.d/renox-single-host.nft
# and included from /etc/nftables.conf, so nftables.service loads it at boot.
#
# RENOX_FIREWALL_ROOT prefixes every path written (tests only).
set -euo pipefail

die() { echo "firewall-single-host: $*" >&2; exit 1; }

dry_run=0
no_ssh=0
ssh_port=22
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) dry_run=1; shift ;;
    --no-ssh) no_ssh=1; shift ;;
    --ssh-port)
      [[ $# -ge 2 ]] || die "--ssh-port needs a value"
      ssh_port=$2; shift 2 ;;
    -h | --help) sed -n '2,33p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "firewall-single-host: unknown option $1" >&2; exit 2 ;;
  esac
done
[[ $ssh_port =~ ^[0-9]{1,5}$ && $ssh_port -ge 1 && $ssh_port -le 65535 ]] || die "--ssh-port must be a port number from 1 to 65535, not '$ssh_port'"
[[ $ssh_port != 80 && $ssh_port != 443 ]] || die "--ssh-port $ssh_port is the worker's port; sshd cannot share it"

root=${RENOX_FIREWALL_ROOT:-}
table=renox_single_host
open_tcp="$ssh_port, 80, 443"

[[ $(id -u) -eq 0 ]] || die "run as root (it loads nftables rules)"
command -v nft >/dev/null 2>&1 || die "nft is not installed (apt-get install nftables)"
command -v ss >/dev/null 2>&1 || die "ss is not installed (iproute2); cannot confirm the SSH session stays allowed"

# --- 1. SSH stays reachable -------------------------------------------------

# Local ports sshd listens on, one per line: sshd's own sockets, and on
# Ubuntu 24.04 the sockets of ssh.socket (socket activation, the default),
# which systemd holds.
sshd_listen_ports() {
  {
    ss -Htlnp 2>/dev/null | awk '/users:\(\("sshd"/ { n = split($4, a, ":"); print a[n] }'
    if command -v systemctl >/dev/null 2>&1 && [[ $(systemctl is-active ssh.socket 2>/dev/null || true) == active ]]; then
      systemctl show ssh.socket -p Listen --value 2>/dev/null | tr ' ' '\n' | awk -F: '/:[0-9]+$/ { print $NF }'
    fi
  } | sort -u
}
# Local ports of established connections owned by sshd, one per line.
sshd_session_ports() {
  ss -Htnp state established 2>/dev/null | awk '/users:\(\("sshd/ { n = split($3, a, ":"); print a[n] }' | sort -u
}

listen_ports=$(sshd_listen_ports)
if [[ -z $listen_ports ]]; then
  if [[ $no_ssh -eq 1 ]]; then
    echo "firewall-single-host: no sshd is listening; --no-ssh given, continuing (port $ssh_port stays open)"
  else
    die "cannot find an sshd listening (ss -tlnp): refusing, since the SSH session cannot be confirmed to stay allowed; pass --no-ssh on a console-only host"
  fi
else
  if ! grep -qx "$ssh_port" <<< "$listen_ports"; then
    die "sshd listens on port(s) $(paste -sd, <<< "$listen_ports"), not $ssh_port: these rules open $ssh_port only and would lock SSH out; refusing (pass the port sshd uses with --ssh-port)"
  fi
fi

if [[ -n ${SSH_CONNECTION:-} ]]; then
  read -r _ _ _ server_port <<< "$SSH_CONNECTION"
  [[ ${server_port:-} =~ ^[0-9]+$ ]] || die "SSH_CONNECTION is set but malformed; cannot confirm the SSH session stays allowed: refusing"
  [[ $server_port == "$ssh_port" ]] || die "this SSH session arrived on port $server_port, which these rules do not open: refusing"
fi
session_ports=$(sshd_session_ports)
if [[ -n $session_ports ]]; then
  while read -r p; do
    [[ $p == "$ssh_port" ]] || die "an established SSH session uses local port $p, which these rules do not open: refusing"
  done <<< "$session_ports"
fi

# --- 2. The ruleset ---------------------------------------------------------

ruleset() {
  cat <<NFT
# Written by ops/scripts/firewall-single-host.sh (#366). Do not edit by hand:
# run the script again. Inbound TCP ${open_tcp} only; outbound unrestricted.
table inet ${table}
delete table inet ${table}
table inet ${table} {
  chain input {
    type filter hook input priority filter; policy drop;
    iif "lo" accept
    ct state established,related accept
    ct state invalid drop
    # The SSH port (${ssh_port}) first: SSH is never closed by these rules.
    tcp dport ${ssh_port} accept
    tcp dport { 80, 443 } accept
    ip protocol icmp icmp type { echo-request, destination-unreachable, time-exceeded, parameter-problem } accept
    ip6 nexthdr ipv6-icmp icmpv6 type { echo-request, destination-unreachable, packet-too-big, time-exceeded, parameter-problem, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept
  }
}
NFT
}

conf_dir=$root/etc/nftables.d
rules_file=$conf_dir/renox-single-host.nft
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ruleset > "$work/rules.nft"

# The ruleset must parse before anything is loaded.
nft -c -f "$work/rules.nft" || die "the generated ruleset does not parse; nothing changed"

if [[ $dry_run -eq 1 ]]; then
  cat "$work/rules.nft"
  echo "firewall-single-host: dry run, nothing loaded"
  exit 0
fi

# --- 3. Load, read back, persist --------------------------------------------

nft -f "$work/rules.nft"
loaded=$(nft list table inet "$table")
if ! grep -Eq "tcp dport ${ssh_port} accept" <<< "$loaded"; then
  nft delete table inet "$table" || true
  die "the loaded table has no port ${ssh_port} rule; removed it again, SSH is unaffected"
fi

install -d -m 0755 "$conf_dir"
install -m 0644 "$work/rules.nft" "$rules_file"
conf=$root/etc/nftables.conf
include="include \"/etc/nftables.d/renox-single-host.nft\""
if [[ ! -f $conf ]]; then
  printf '#!/usr/sbin/nft -f\n%s\n' "$include" > "$conf"
elif ! grep -qxF "$include" "$conf"; then
  printf '\n# The single host firewall (ops/scripts/firewall-single-host.sh).\n%s\n' "$include" >> "$conf"
fi
if [[ -z $root ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl enable nftables.service >/dev/null 2>&1 || echo "firewall-single-host: could not enable nftables.service; the rules are loaded but will not survive a reboot" >&2
fi
echo "firewall-single-host: inbound tcp ${open_tcp} open, everything else dropped (table inet ${table})"
