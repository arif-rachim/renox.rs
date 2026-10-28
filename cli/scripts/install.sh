#!/bin/sh
# Install the renox CLI from a GitHub Release, verifying its SHA-256, and the
# renox-worker version that CLI release pins (#163;
# docs/12-developer-experience.md, "Installing the CLI").
#
#   curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v<version>/install.sh | sh
#   sh install.sh [<version>]
#
# Release assets (.github/workflows/release-cli.yml), on the release tagged
# cli-v<version>:
#   renox-<version>-<os>-<arch>           the binary; os linux or darwin, arch x64 or arm64
#   renox-<version>-<os>-<arch>.sha256    its SHA-256 (hex, optionally followed by the file name)
#   worker-version.txt                    the renox-worker version this CLI is tested against
# The worker comes from the release worker-v<worker version> under the names of
# cli/scripts/fetch-worker.ts: renox-worker-<version>-<rust target>(.sha256).
#
# Environment:
#   RENOX_VERSION        the CLI version (default: the argument, else the newest cli-v* release)
#   RENOX_INSTALL_DIR    where renox and renox-worker go (default: $HOME/.renox/bin)
#   RENOX_RELEASE_BASE   replaces https://github.com/<repo>/releases/download (same layout:
#                        <base>/<tag>/<asset>), for a mirror or the release workflow's smoke test
#   RENOX_RELEASE_REPO   owner/repo (default: arif-rachim/renox.rs)
#   RENOX_NO_WORKER=1    skip the worker (renox new, check, and build of an app without templates/ do not need it)
#
# Nothing is installed unless its checksum matches. Needs curl or wget, and
# sha256sum or shasum. Signature verification of the release is #129.

set -eu

REPO=${RENOX_RELEASE_REPO:-arif-rachim/renox.rs}
BASE=${RENOX_RELEASE_BASE:-https://github.com/$REPO/releases/download}
DIR=${RENOX_INSTALL_DIR:-${HOME:?HOME is not set}/.renox/bin}
# Plain http only for an explicit http:// base (a local mirror or the smoke test).
case $BASE in
  http://*) PROTO='=https,http' ;;
  *) PROTO='=https' ;;
esac

say() { printf 'renox install: %s\n' "$*" >&2; }
die() {
  say "$*"
  exit 1
}

# get <url> <file>
get() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto "$PROTO" --retry 3 -o "$2" "$1" || die "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "download failed: $1"
  else
    die "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "sha256sum or shasum is required to verify the download"
  fi
}

# fetch_verified <tag> <asset> <destination>: download the asset and its .sha256, install only on a match.
fetch_verified() {
  get "$BASE/$1/$2" "$TMP/$2"
  get "$BASE/$1/$2.sha256" "$TMP/$2.sha256"
  expected=$(cut -d ' ' -f 1 <"$TMP/$2.sha256" | tr -d '\r\n')
  case $expected in
    *[!0-9a-f]* | "") die "$2.sha256 does not hold a SHA-256 digest" ;;
  esac
  [ ${#expected} -eq 64 ] || die "$2.sha256 does not hold a SHA-256 digest"
  actual=$(sha256 "$TMP/$2")
  [ "$actual" = "$expected" ] || die "checksum mismatch for $2: expected $expected, got $actual; nothing installed"
  chmod 755 "$TMP/$2"
  mv -f "$TMP/$2" "$3"
}

valid_version() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "no renox build for $(uname -s); Linux and macOS are supported" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "no renox build for $(uname -m); x86_64 and arm64 are supported" ;;
esac
# A shell running under Rosetta 2 reports x86_64 on an arm64 Mac.
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM

version=${RENOX_VERSION:-${1:-}}
if [ -z "$version" ]; then
  # The newest cli-v* release; worker-v* releases share the repository, so
  # releases/latest is not necessarily a CLI.
  get "https://api.github.com/repos/$REPO/releases?per_page=100" "$TMP/releases.json"
  version=$(grep -Eo '"tag_name": *"cli-v[^"]+"' "$TMP/releases.json" | head -n 1 | sed 's/.*"cli-v//; s/"$//')
  [ -n "$version" ] || die "no cli-v* release found in $REPO; pass a version"
fi
version=${version#cli-v}
valid_version "$version" || die "invalid version $version (expected for example 0.1.0)"

mkdir -p "$DIR"
fetch_verified "cli-v$version" "renox-$version-$os-$arch" "$DIR/renox"
say "renox $version -> $DIR/renox"

if [ "${RENOX_NO_WORKER:-}" != 1 ]; then
  get "$BASE/cli-v$version/worker-version.txt" "$TMP/worker-version.txt"
  worker=$(tr -d ' \r\n' <"$TMP/worker-version.txt")
  valid_version "$worker" || die "worker-version.txt does not hold a version"
  case $os-$arch in
    linux-x64) target=x86_64-unknown-linux-gnu ;;
    linux-arm64) target=aarch64-unknown-linux-gnu ;;
    darwin-x64) target=x86_64-apple-darwin ;;
    darwin-arm64) target=aarch64-apple-darwin ;;
  esac
  asset="renox-worker-$worker-$target"
  # Only linux-x64 workers are released so far (#139 adds the others); the
  # CLI still builds and checks without one.
  if (get "$BASE/worker-v$worker/$asset.sha256" "$TMP/probe") 2>/dev/null; then
    fetch_verified "worker-v$worker" "$asset" "$DIR/renox-worker"
    say "renox-worker $worker -> $DIR/renox-worker"
    say "renox dev uses it with: export RENOX_WORKER_PATH=\"$DIR/renox-worker\""
  else
    say "no renox-worker $worker build for $os-$arch yet; renox new, check, and build without templates/ work without it; renox dev needs RENOX_WORKER_PATH"
  fi
fi

case :${PATH}: in
  *":$DIR:"*) ;;
  *) say "add $DIR to PATH: export PATH=\"$DIR:\$PATH\"" ;;
esac
