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
#   --worker-variant <default|pdf>
#                            default: the release build (ctx.pdf.render answers pdf_unavailable).
#                            pdf: the build with the pdf feature, renox-worker-<v>-<target>-pdf.gz,
#                            SHA-256 verified then gunzipped. Use it on a node that runs apps with
#                            tax_gcc invoices or reports. Recorded in /opt/renox/worker-variant.
#   --worker-bin <file>      install this binary instead of downloading the release
#   --litestream-bin <file>  install this binary instead of ops/scripts/fetch-litestream.sh
#   --config <file>          install this worker.toml instead of the example
#   --no-enable              install everything but do not enable or start the target
#
# Single host (#366, #420, ops/single-host.md): the worker and the control
# plane on one machine, tunnel-only (ADR D25). --single-host also installs
# cloudflared (SHA-256 verified, ops/cloudflared.lock), the backup script, the
# `renox-control` user, and the templates of /etc/renox/control.env (0600) and
# /etc/renox/tunnel/config.yml, each written once. Every node gets the group
# `renox-edge`, the user `renox-tunnel` (cloudflared, the one peer the worker's
# socket trusts, #414) and /run/renox-edge by tmpfiles. It enables only
# the worker: the control plane, the tunnel and the timers need the owner's
# secrets first.
# The control URL is then the node listener on loopback, plain HTTP
# (http://127.0.0.1:8788), and --blocked-addresses must name that address and
# at least one public address of the node.
#   --single-host
#   --cloudflared-bin <file> install this binary instead of ops/scripts/fetch-cloudflared.sh
#
# RENOX_RELEASE_BASE replaces https://github.com/<repo>/releases/download, as in
# cli/scripts/fetch-worker.ts (layout <base>/worker-v<version>/<asset>).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

worker_version=""
worker_variant="default"
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
single_host=0
cloudflared_bin=""

die() { echo "bootstrap-node: $*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value"; }

worker_target() {
  case $(uname -m) in
    x86_64) echo x86_64-unknown-linux-gnu ;;
    aarch64) echo aarch64-unknown-linux-gnu ;;
    *) die "no renox-worker build for $(uname -m)" ;;
  esac
}

# fetch_worker <version> <variant> <dest>: downloads the release asset of this
# machine's target (renox-worker-<v>-<target>, or ...-pdf.gz for the pdf
# variant), checks it against its .sha256, and writes the runnable binary to
# <dest> (gunzipped for pdf). Nothing is written to <dest> on a failure.
fetch_worker() {
  local version=$1 variant=$2 dest=$3
  local repo=${RENOX_RELEASE_REPO:-arif-rachim/renox.rs}
  local base=${RENOX_RELEASE_BASE:-https://github.com/$repo/releases/download}
  local asset
  asset=renox-worker-$version-$(worker_target)
  [[ $variant == pdf ]] && asset+=-pdf.gz
  local work
  work=$(mktemp -d)
  curl --fail --silent --show-error --location --proto '=https,file' --retry 3 \
    --output "$work/$asset" "$base/worker-v$version/$asset" || { rm -rf "$work"; die "download of $asset failed"; }
  curl --fail --silent --show-error --location --proto '=https,file' --retry 3 \
    --output "$work/$asset.sha256" "$base/worker-v$version/$asset.sha256" || { rm -rf "$work"; die "download of $asset.sha256 failed"; }
  local expected actual
  expected=$(awk '{ print $1; exit }' "$work/$asset.sha256")
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || { rm -rf "$work"; die "the .sha256 asset does not hold a SHA-256 digest"; }
  actual=$(sha256sum "$work/$asset" | awk '{ print $1 }')
  [[ $actual == "$expected" ]] || { rm -rf "$work"; die "checksum mismatch for $asset: expected $expected, got $actual"; }
  if [[ $variant == pdf ]]; then
    gunzip -c "$work/$asset" > "$work/unpacked" || { rm -rf "$work"; die "$asset is not a valid gzip file"; }
    mv -f "$work/unpacked" "$dest"
  else
    mv -f "$work/$asset" "$dest"
  fi
  rm -rf "$work"
}

# Sourced by a test: only the functions above are wanted.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then return 0; fi

while [[ $# -gt 0 ]]; do
  case $1 in
    --worker-version) need_value "$@"; worker_version=$2; shift 2 ;;
    --node-id) need_value "$@"; node_id=$2; shift 2 ;;
    --control-url) need_value "$@"; control_url=$2; shift 2 ;;
    --region) need_value "$@"; region=$2; shift 2 ;;
    --blocked-addresses) need_value "$@"; blocked=$2; shift 2 ;;
    --node-token-file) need_value "$@"; node_token_file=$2; shift 2 ;;
    --health-listen) need_value "$@"; health_listen=$2; shift 2 ;;
    --worker-variant) need_value "$@"; [[ $2 == default || $2 == pdf ]] || die "--worker-variant must be default or pdf"; worker_variant=$2; shift 2 ;;
    --upgrade) upgrade=1; shift ;;
    --worker-bin) need_value "$@"; worker_bin=$2; shift 2 ;;
    --litestream-bin) need_value "$@"; litestream_bin=$2; shift 2 ;;
    --config) need_value "$@"; config_file=$2; shift 2 ;;
    --no-enable) enable=0; shift ;;
    --single-host) single_host=1; shift ;;
    --cloudflared-bin) need_value "$@"; cloudflared_bin=$2; shift 2 ;;
    -h | --help) sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

[[ $(id -u) -eq 0 ]] || die "run as root (it creates a user and installs systemd units)"
[[ $worker_version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "--worker-version must be a version like 0.3.0"
if [[ -z $config_file ]]; then
  [[ $node_id =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || die "--node-id is required (lowercase, digits, . _ -)"
  if [[ $single_host -eq 1 ]]; then
    [[ $control_url =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]] || die "--single-host: --control-url must be the node listener on loopback, like http://127.0.0.1:8788"
  else
    [[ $control_url == https://* ]] || die "--control-url must be the https:// URL of the control plane's node listener"
  fi
  [[ $region =~ ^[a-z0-9-]{1,32}$ ]] || die "--region must be like me-central-1"
  [[ -n $blocked ]] || die "--blocked-addresses must list the node's own addresses and the control plane's node-facing ones"
  [[ -n $node_token_file && -f $node_token_file ]] || die "--node-token-file must name the file holding the renox_node_ token"
  if [[ $single_host -eq 1 ]]; then
    # The worker refuses tenant fetch to every listed address on top of the
    # private ranges: the control plane's node listener and the node's own
    # public addresses must be in the list (ADR D23, #218).
    IFS=',' read -r -a check <<< "$blocked"
    has_control=0
    has_public=0
    for a in "${check[@]}"; do
      [[ $a == 127.0.0.1 ]] && has_control=1
      [[ $a != 127.* && $a != ::1 && $a != 10.* && $a != 192.168.* && ! $a =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] && has_public=1
    done
    [[ $has_control -eq 1 ]] || die "--single-host: --blocked-addresses must list 127.0.0.1 (the control plane's node listener)"
    [[ $has_public -eq 1 ]] || die "--single-host: --blocked-addresses must list the node's public address(es)"
  fi
fi

target=$(worker_target)

bin_dir=/opt/renox/bin
etc_dir=/etc/renox
state_dir=/var/lib/renox
unit_dir=/etc/systemd/system
version_file=/opt/renox/worker-version
variant_file=/opt/renox/worker-variant

# 1. Refuse a silent version change.
installed=""
installed_variant="default"
if [[ -f $version_file ]]; then installed=$(<"$version_file"); fi
if [[ -f $variant_file ]]; then installed_variant=$(<"$variant_file"); fi
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
for d in data artifacts meters logs spool replica; do
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
elif [[ $installed == "$worker_version" && $installed_variant == "$worker_variant" && -x $bin_dir/renox-worker ]]; then
  echo "renox-worker $worker_version ($worker_variant) already installed"
else
  fetch_worker "$worker_version" "$worker_variant" "$tmp/renox-worker"
  install_worker "$tmp/renox-worker"
fi
printf '%s\n' "$worker_version" > "$version_file"
printf '%s\n' "$worker_variant" > "$variant_file"

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
# The node token and the platform key: renox:renox 0400. The worker runs as
# `renox` and refuses either file with any group or other bit
# (crates/renox-cell/src/control/http.rs, src/pages/keys.rs), so root:renox
# 0640 never starts it (#393). A file an older bootstrap installed is
# corrected in place; its content is never touched.
if [[ -n $node_token_file && ! -f $etc_dir/node.token ]]; then
  install -m 0400 -o renox -g renox "$node_token_file" "$etc_dir/node.token"
fi
if [[ ! -f $etc_dir/platform.key ]]; then
  head -c 32 /dev/urandom > "$tmp/platform.key"
  install -m 0400 -o renox -g renox "$tmp/platform.key" "$etc_dir/platform.key"
fi
for f in "$etc_dir/node.token" "$etc_dir/platform.key"; do
  if [[ -f $f ]]; then chown renox:renox "$f" && chmod 0400 "$f"; fi
done

# The worker's socket behind cloudflared (#414, ADR D25): /run/renox-edge,
# renox:renox-edge 0750, made at every boot by systemd-tmpfiles. The worker
# creates worker.sock in it (0660, group renox-edge: [gateway] socket_group)
# and trusts only the renox-tunnel uid on it ([gateway] trusted_socket_users).
# The group and cloudflared's user exist on every node: renox-worker.service
# names the group and worker.toml.example the user (a name the worker cannot
# resolve stops it at start).
if ! getent group renox-edge >/dev/null 2>&1; then groupadd --system renox-edge; fi
if ! id -u renox-tunnel >/dev/null 2>&1; then
  useradd --system --gid renox-edge --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin renox-tunnel
fi
install -d -m 0755 /etc/tmpfiles.d
printf 'd /run/renox-edge 0750 renox renox-edge -\n' > /etc/tmpfiles.d/renox-edge.conf
if command -v systemd-tmpfiles >/dev/null 2>&1; then systemd-tmpfiles --create /etc/tmpfiles.d/renox-edge.conf || true; fi

# 5. Units, slices, timers, polkit rule (the *.example files are templates, not units).
for f in "$here"/systemd/*.service "$here"/systemd/*.slice "$here"/systemd/*.target "$here"/systemd/*.timer; do
  install -m 0644 "$f" "$unit_dir/$(basename "$f")"
done
if [[ -d /etc/polkit-1/rules.d ]]; then
  install -m 0644 "$here/polkit/50-renox.rules" /etc/polkit-1/rules.d/50-renox.rules
fi
# 6. Single host: the control plane's binaries, user and templates (#366).
if [[ $single_host -eq 1 ]]; then
  if [[ -n $cloudflared_bin ]]; then
    [[ -f $cloudflared_bin ]] || die "--cloudflared-bin $cloudflared_bin does not exist"
    install -m 0755 "$cloudflared_bin" "$bin_dir/cloudflared"
  else
    install -m 0755 "$("$here/scripts/fetch-cloudflared.sh" "$target" "$tmp/cloudflared")" "$bin_dir/cloudflared"
  fi
  install -m 0755 "$here/scripts/backup-control-db.sh" "$bin_dir/backup-control-db.sh"
  # #517: local backups while R2 is off (root-only directory, the weekly tenant snapshot, the drill).
  install -d -m 0700 -o root -g root /var/backups/renox
  install -m 0755 "$here/scripts/backup-tenant-files.sh" "$bin_dir/backup-tenant-files.sh"
  install -m 0755 "$here/scripts/restore-check.sh" "$bin_dir/restore-check.sh"
  # #450: OnFailure= of the backup and billing units (renox-alert@.service).
  install -m 0755 "$here/scripts/renox-alert.sh" "$bin_dir/renox-alert.sh"
  if ! id -u renox-control >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/renox-control --no-create-home --shell /usr/sbin/nologin renox-control
  fi
  install -d -m 0700 -o root -g root "$etc_dir/secrets"
  install -d -m 0755 -o root -g root "$etc_dir/tunnel"
  write_once() {
    local src=$1 dest=$2 mode=$3
    if [[ -f $dest ]]; then echo "$dest exists; left unchanged"; else install -m "$mode" -o root -g root "$src" "$dest"; fi
  }
  write_once "$here/systemd/control.env.example" "$etc_dir/control.env" 0600
  write_once "$here/cloudflared/config.yml.example" "$etc_dir/tunnel/config.yml" 0644
fi
systemctl daemon-reload

if [[ $enable -eq 1 ]]; then
  systemctl enable renox-node.target renox-worker.service
  if [[ -n $installed && ( $installed != "$worker_version" || $installed_variant != "$worker_variant" ) ]]; then
    systemctl restart renox-worker.service
  else
    systemctl start renox-node.target
  fi
  systemctl is-active --quiet renox-worker.service || die "renox-worker did not start: journalctl -u renox-worker"
fi
echo "renox node ready: renox-worker $worker_version, litestream $(awk '$1 == "version" { print $2 }' "$here/litestream.lock")"
if [[ $single_host -eq 1 ]]; then
  echo "single host: cloudflared $(awk '$1 == "version" { print $2 }' "$here/cloudflared.lock") installed;"
  echo "  fill in /etc/renox/control.env and the files under /etc/renox/secrets and /etc/renox/tunnel, then follow ops/single-host.md"
fi
