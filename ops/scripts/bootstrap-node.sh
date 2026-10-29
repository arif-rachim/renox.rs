#!/usr/bin/env bash
# Sets up a Renox worker node from ops/ alone (#252, ops/README.md):
# the `renox` user and its directories, the systemd units and slices, the
# polkit rule, the worker release and Litestream (both SHA-256 verified),
# /etc/renox/worker.toml from ops/worker.toml.example, then enables
# renox-node.target.
#
#   sudo ops/scripts/bootstrap-node.sh --worker-version 0.3.0 \
#     --node-id node-dxb-01 --control-url https://10.0.1.5:8788 \
#     --region me-central-1 --blocked-addresses 203.0.113.10,10.0.1.5 \
#     --node-token-file ./node.token [--health-listen 10.0.1.11:9090]
#
# Idempotent: a second run with the same version changes nothing. A node
# that already runs another worker version is refused unless --upgrade is
# given; the previous binary is kept as renox-worker.prev for rollback.
#
# Options for tests and air-gapped hosts:
#   --worker-bin <file>      install this binary instead of downloading the release
#   --litestream-bin <file>  install this binary instead of ops/scripts/fetch-litestream.sh
#   --config <file>          install this worker.toml instead of the example
#   --no-enable              install everything but do not enable or start the target
#
# RENOX_RELEASE_BASE replaces https://github.com/<repo>/releases/download, as in
# cli/scripts/fetch-worker.ts (layout <base>/worker-v<version>/<asset>).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

worker_version=""
node_id=""
control_url=""
region="me-central-1"
blocked=""
node_token_file=""
health_listen="127.0.0.1:9090"
upgrade=0
worker_bin=""
litestream_bin=""
config_file=""
enable=1

die() { echo "bootstrap-node: $*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --worker-version) need_value "$@"; worker_version=$2; shift 2 ;;
    --node-id) need_value "$@"; node_id=$2; shift 2 ;;
    --control-url) need_value "$@"; control_url=$2; shift 2 ;;
    --region) need_value "$@"; region=$2; shift 2 ;;
    --blocked-addresses) need_value "$@"; blocked=$2; shift 2 ;;
    --node-token-file) need_value "$@"; node_token_file=$2; shift 2 ;;
    --health-listen) need_value "$@"; health_listen=$2; shift 2 ;;
    --upgrade) upgrade=1; shift ;;
    --worker-bin) need_value "$@"; worker_bin=$2; shift 2 ;;
    --litestream-bin) need_value "$@"; litestream_bin=$2; shift 2 ;;
    --config) need_value "$@"; config_file=$2; shift 2 ;;
    --no-enable) enable=0; shift ;;
    -h | --help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

[[ $(id -u) -eq 0 ]] || die "run as root (it creates a user and installs systemd units)"
[[ $worker_version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "--worker-version must be a version like 0.3.0"
if [[ -z $config_file ]]; then
  [[ $node_id =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || die "--node-id is required (lowercase, digits, . _ -)"
  [[ $control_url == https://* ]] || die "--control-url must be the https:// URL of the control plane's node listener"
  [[ $region =~ ^[a-z0-9-]{1,32}$ ]] || die "--region must be like me-central-1"
  [[ -n $blocked ]] || die "--blocked-addresses must list the node's own addresses and the control plane's node-facing ones"
  [[ -n $node_token_file && -f $node_token_file ]] || die "--node-token-file must name the file holding the renox_node_ token"
fi

case $(uname -m) in
  x86_64) target=x86_64-unknown-linux-gnu ;;
  aarch64) target=aarch64-unknown-linux-gnu ;;
  *) die "no renox-worker build for $(uname -m)" ;;
esac

bin_dir=/opt/renox/bin
etc_dir=/etc/renox
state_dir=/var/lib/renox
unit_dir=/etc/systemd/system
version_file=/opt/renox/worker-version

# 1. Refuse a silent version change.
installed=""
if [[ -f $version_file ]]; then installed=$(<"$version_file"); fi
if [[ -n $installed && $installed != "$worker_version" && $upgrade -ne 1 ]]; then
  die "this node runs renox-worker $installed; pass --upgrade to install $worker_version"
fi

# 2. User and directories.
if ! id -u renox >/dev/null 2>&1; then
  useradd --system --home-dir "$state_dir" --no-create-home --shell /usr/sbin/nologin renox
fi
install -d -m 0755 /opt/renox "$bin_dir"
install -d -m 0750 -o root -g renox "$etc_dir"
install -d -m 0750 -o renox -g renox "$state_dir"
for d in data artifacts meters logs spool replica data/_certs; do
  install -d -m 0750 -o renox -g renox "$state_dir/$d"
done

# 3. Binaries, each verified before it is moved into place.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

install_worker() {
  local new=$1
  if [[ -f $bin_dir/renox-worker ]] && ! cmp -s "$new" "$bin_dir/renox-worker"; then
    cp -p "$bin_dir/renox-worker" "$bin_dir/renox-worker.prev"
  fi
  install -m 0755 "$new" "$bin_dir/renox-worker.new"
  mv -f "$bin_dir/renox-worker.new" "$bin_dir/renox-worker"
}

if [[ -n $worker_bin ]]; then
  [[ -f $worker_bin ]] || die "--worker-bin $worker_bin does not exist"
  install_worker "$worker_bin"
elif [[ $installed == "$worker_version" && -x $bin_dir/renox-worker ]]; then
  echo "renox-worker $worker_version already installed"
else
  repo=${RENOX_RELEASE_REPO:-arif-rachim/renox.rs}
  base=${RENOX_RELEASE_BASE:-https://github.com/$repo/releases/download}
  asset=renox-worker-$worker_version-$target
  curl --fail --silent --show-error --location --proto '=https,file' --retry 3 \
    --output "$tmp/$asset" "$base/worker-v$worker_version/$asset"
  curl --fail --silent --show-error --location --proto '=https,file' --retry 3 \
    --output "$tmp/$asset.sha256" "$base/worker-v$worker_version/$asset.sha256"
  expected=$(awk '{ print $1; exit }' "$tmp/$asset.sha256")
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || die "the .sha256 asset does not hold a SHA-256 digest"
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
  [[ $actual == "$expected" ]] || die "checksum mismatch for $asset: expected $expected, got $actual"
  install_worker "$tmp/$asset"
fi
printf '%s\n' "$worker_version" > "$version_file"

if [[ -n $litestream_bin ]]; then
  [[ -f $litestream_bin ]] || die "--litestream-bin $litestream_bin does not exist"
  install -m 0755 "$litestream_bin" "$bin_dir/litestream"
else
  fetched=$("$here/scripts/fetch-litestream.sh" "$target" "$tmp/litestream")
  install -m 0755 "$fetched" "$bin_dir/litestream"
fi

# 4. Configuration: written once, never overwritten.
if [[ ! -f $etc_dir/worker.toml ]]; then
  if [[ -n $config_file ]]; then
    install -m 0640 -o root -g renox "$config_file" "$etc_dir/worker.toml"
  else
    addresses=""
    IFS=',' read -r -a list <<< "$blocked"
    for a in "${list[@]}"; do
      [[ $a =~ ^[0-9a-fA-F:.]+$ ]] || die "--blocked-addresses: $a is not an IP address"
      addresses+="${addresses:+, }\"$a\""
    done
    sed -e "s|@NODE_ID@|$node_id|" -e "s|@CONTROL_URL@|$control_url|" -e "s|@REGION@|$region|" \
      -e "s|@BLOCKED_ADDRESSES@|$addresses|" -e "s|@HEALTH_LISTEN@|$health_listen|" \
      "$here/worker.toml.example" > "$tmp/worker.toml"
    install -m 0640 -o root -g renox "$tmp/worker.toml" "$etc_dir/worker.toml"
  fi
else
  echo "/etc/renox/worker.toml exists; left unchanged"
fi
if [[ -n $node_token_file && ! -f $etc_dir/node.token ]]; then
  install -m 0640 -o root -g renox "$node_token_file" "$etc_dir/node.token"
fi
if [[ ! -f $etc_dir/platform.key ]]; then
  head -c 32 /dev/urandom > "$tmp/platform.key"
  install -m 0640 -o root -g renox "$tmp/platform.key" "$etc_dir/platform.key"
fi

# 5. Units, slices, polkit rule.
for f in "$here"/systemd/*; do
  install -m 0644 "$f" "$unit_dir/$(basename "$f")"
done
if [[ -d /etc/polkit-1/rules.d ]]; then
  install -m 0644 "$here/polkit/50-renox.rules" /etc/polkit-1/rules.d/50-renox.rules
fi
systemctl daemon-reload

if [[ $enable -eq 1 ]]; then
  systemctl enable renox-node.target renox-worker.service
  if [[ -n $installed && $installed != "$worker_version" ]]; then
    systemctl restart renox-worker.service
  else
    systemctl start renox-node.target
  fi
  systemctl is-active --quiet renox-worker.service || die "renox-worker did not start: journalctl -u renox-worker"
fi
echo "renox node ready: renox-worker $worker_version, litestream $(awk '$1 == "version" { print $2 }' "$here/litestream.lock")"
