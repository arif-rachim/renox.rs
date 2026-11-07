# Install the renox CLI for Windows from a GitHub Release, verifying its
# SHA-256 (#508; docs/12-developer-experience.md, "Installing the CLI").
# The Windows twin of install.sh.
#
#   irm https://github.com/arif-rachim/renox.rs/releases/download/cli-v<version>/install.ps1 -OutFile install.ps1; .\install.ps1 [<version>]
#
# Release assets (.github/workflows/release-cli.yml), on the release tagged
# cli-v<version>:
#   renox-<version>-windows-x64.exe          the binary
#   renox-<version>-windows-x64.exe.sha256   its SHA-256 (hex, optionally followed by the file name)
#
# The development renox-worker.exe (#531, #442) comes from the release
# worker-v<worker version>, the version in the CLI release's worker-version.txt
# (as install.sh does):
#   renox-worker-<worker version>-x86_64-pc-windows-msvc.exe         the worker
#   renox-worker-<worker version>-x86_64-pc-windows-msvc.exe.sha256  its SHA-256
# It is installed beside renox.exe, after the same checksum check. When the
# worker release has no Windows build, that is a warning: renox new, check and
# build of an app without .html pages or policies, login, deploy, logs, secrets
# and db work without it; renox dev and test need it, or WSL 2.
#
# Environment:
#   RENOX_VERSION        the CLI version (default: the argument, else the newest cli-v* release)
#   RENOX_INSTALL_DIR    where renox.exe goes (default: %LOCALAPPDATA%\renox\bin)
#   RENOX_RELEASE_BASE   replaces https://github.com/<repo>/releases/download (same layout:
#                        <base>/<tag>/<asset>), for a mirror or a test
#   RENOX_RELEASE_REPO   owner/repo (default: arif-rachim/renox.rs)
#   RENOX_NO_WORKER=1    skip the worker
#   RENOX_NO_MODIFY_PATH=1
#                        do not add the install folder to the user Path
#
# Nothing is installed unless its checksum matches.

param([string]$Version = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$Message) { [Console]::Error.WriteLine("renox install: $Message") }

try {
  $repo = if ($env:RENOX_RELEASE_REPO) { $env:RENOX_RELEASE_REPO } else { 'arif-rachim/renox.rs' }
  $base = if ($env:RENOX_RELEASE_BASE) { $env:RENOX_RELEASE_BASE.TrimEnd('/') } else { "https://github.com/$repo/releases/download" }
  $dir = if ($env:RENOX_INSTALL_DIR) { $env:RENOX_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'renox\bin' }

  # Plain http only for an explicit http:// base (a local mirror or a test).
  if (-not $base.StartsWith('https://') -and -not $base.StartsWith('http://')) { throw "RENOX_RELEASE_BASE must be an http(s) URL: $base" }

  if (-not $Version) { $Version = $env:RENOX_VERSION }
  if (-not $Version) {
    # The newest cli-v* release; worker-v* releases share the repository, so
    # releases/latest is not necessarily a CLI.
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -UseBasicParsing
    $tag = $releases | Where-Object { $_.tag_name -like 'cli-v*' } | Select-Object -First 1 -ExpandProperty tag_name
    if (-not $tag) { throw "no cli-v* release found in $repo; pass a version" }
    $Version = $tag
  }
  if ($Version.StartsWith('cli-v')) { $Version = $Version.Substring(5) }
  if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { throw "invalid version $Version (expected for example 0.1.0)" }

  if ($env:PROCESSOR_ARCHITECTURE -and $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    Say "no native renox build for $($env:PROCESSOR_ARCHITECTURE); installing the x64 build, which Windows on Arm runs under emulation"
  }

  $asset = "renox-$Version-windows-x64.exe"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("renox-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $file = Join-Path $tmp $asset
    Invoke-WebRequest -Uri "$base/cli-v$Version/$asset" -OutFile $file -UseBasicParsing
    $shaFile = Join-Path $tmp "$asset.sha256"
    Invoke-WebRequest -Uri "$base/cli-v$Version/$asset.sha256" -OutFile $shaFile -UseBasicParsing

    $expected = ((Get-Content -Raw -LiteralPath $shaFile).Trim() -split '\s+')[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') { throw "$asset.sha256 does not hold a SHA-256 digest" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "checksum mismatch for ${asset}: expected $expected, got $actual; nothing installed" }

    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $dest = Join-Path $dir 'renox.exe'
    Move-Item -Force -LiteralPath $file -Destination $dest

    if ($env:RENOX_NO_WORKER -ne '1') {
      # The worker version the CLI release is tested against. Without the file
      # (an older release) or without a Windows build, warn and go on.
      $workerVersion = ''
      try {
        $wvFile = Join-Path $tmp 'worker-version.txt'
        Invoke-WebRequest -Uri "$base/cli-v$Version/worker-version.txt" -OutFile $wvFile -UseBasicParsing
        $workerVersion = (Get-Content -Raw -LiteralPath $wvFile).Trim()
      } catch {
        Say "no worker-version.txt in cli-v$Version; dev and test need WSL 2"
      }
      if ($workerVersion) {
        if ($workerVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { throw "worker-version.txt does not hold a version" }
        $wAsset = "renox-worker-$workerVersion-x86_64-pc-windows-msvc.exe"
        $wFile = Join-Path $tmp $wAsset
        $wSha = Join-Path $tmp "$wAsset.sha256"
        $found = $true
        try {
          Invoke-WebRequest -Uri "$base/worker-v$workerVersion/$wAsset.sha256" -OutFile $wSha -UseBasicParsing
          Invoke-WebRequest -Uri "$base/worker-v$workerVersion/$wAsset" -OutFile $wFile -UseBasicParsing
        } catch {
          $found = $false
          Say "warning: no Windows renox-worker in worker-v$workerVersion; dev and test need WSL 2"
        }
        if ($found) {
          $wExpected = ((Get-Content -Raw -LiteralPath $wSha).Trim() -split '\s+')[0].ToLowerInvariant()
          if ($wExpected -notmatch '^[0-9a-f]{64}$') { throw "$wAsset.sha256 does not hold a SHA-256 digest" }
          $wActual = (Get-FileHash -Algorithm SHA256 -LiteralPath $wFile).Hash.ToLowerInvariant()
          if ($wActual -ne $wExpected) { throw "checksum mismatch for ${wAsset}: expected $wExpected, got $wActual; renox-worker.exe not installed" }
          $wDest = Join-Path $dir 'renox-worker.exe'
          Move-Item -Force -LiteralPath $wFile -Destination $wDest
          Say "renox-worker $workerVersion -> $wDest (renox finds it beside itself and checks its sha256 before running it)"
        }
      }
    }
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
  Say "renox $Version -> $dest (verified by its checksum; for the sigstore signature see docs/12-developer-experience.md)"

  if ($env:RENOX_NO_MODIFY_PATH -ne '1') {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = if ($userPath) { @($userPath -split ';' | Where-Object { $_ }) } else { @() }
    if ($entries -notcontains $dir) {
      $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $dir } else { $dir }
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      Say "added $dir to your user Path; open a new terminal to use it"
    }
  }
  Say "next: renox new my-app; cd my-app; renox build (renox dev needs renox-worker.exe, or WSL 2)"
} catch {
  Say $_.Exception.Message
  exit 1
}
