# ops

Operational files that the build and CI trust. Owned by code owners (`.github/CODEOWNERS`); every change is reviewed.

| File | What it is |
| --- | --- |
| `v8-checksums.txt` | sha256 of every prebuilt `rusty_v8` archive the build may link |
| `v8-archive.sh` | Downloads the archive for the locked `v8` version, verifies it against `v8-checksums.txt`, prints its path |
| `v8-archive.test.ts` | Tests of the above (`bun test ops`), including one changed byte failing the build |
| `systemd/` | Units of a worker node (#252): `renox-node.target`, `renox-worker.service`, `renox-child@.service`, `renox-litestream@.service`, `renox.slice`, `renox-free.slice`, `renox-paid.slice` ("Worker nodes" below) |
| `polkit/50-renox.rules` | Lets the `renox` user start and stop its own `renox-litestream@*` and `renox-child@*` units, nothing else |
| `worker.toml.example` | The production `worker.toml` that `bootstrap-node.sh` writes once |
| `litestream.lock` | Litestream version and SHA-256 per target |
| `scripts/bootstrap-node.sh` | Sets a node up from `ops/` alone; idempotent; refuses a version change without `--upgrade` |
| `scripts/fetch-litestream.sh` | Downloads the pinned Litestream, refuses a SHA-256 mismatch before extracting, prints the binary's path |
| `scripts/verify-units.sh` | `systemd-analyze verify` over `systemd/` (CI lint job) |
| `security/keys.md` | The key inventory (master key, page session key, backup and export KMS keys, release signing, TLS), custody, rotation procedures and the drill record (#309) |
| `scripts/*.test.sh` | `fetch-litestream.test.sh` (CI lint job, no network) and `bootstrap-node.test.sh` (CI rust job: a systemd container with the worker just built) |
| `single-host.md` | The runbook of the single host (#366): worker, control plane, Postgres and the tunnel on one machine behind Cloudflare, from an empty host to live ("Single host" below) |
| `cloudflared.lock`, `lego.lock` | cloudflared and lego versions and SHA-256 per target (#366) |
| `cloudflared/config.yml.example` | The tunnel's ingress: `api` and `mcp.renoxium.com` → `http://127.0.0.1:8787`, everything else 404 |
| `scripts/fetch-cloudflared.sh`, `scripts/fetch-lego.sh` | Download the pinned binary, refuse a SHA-256 mismatch before it is installed or extracted, print its path |
| `scripts/firewall-single-host.sh` | nftables: inbound SSH (22, or `--ssh-port <n>`), 80, 443 only; refuses unless SSH stays reachable on that port |
| `scripts/renew-wildcard-cert.sh` | `*.renoxium.app` and `renoxium.app` by DNS-01 (lego, Cloudflare), installed for the gateway's `CertStore`, worker reloaded |
| `scripts/backup-control-db.sh` | `pg_dump` encrypted with age, uploaded to R2 with a SigV4 PUT, read back |
| `systemd/control.env.example`, `systemd/single-host.env.example` | Templates of `/etc/renox/control.env` (0600) and `/etc/renox/single-host.env`; never installed as units |

## Verified prebuilt V8

The `v8` crate's build script downloads a static library archive (`librusty_v8<features>_release_<target>.a.gz`) from GitHub and checks nothing, so a tampered archive would end up in every `renox-worker` build (`docs/24-threat-model.md` section F, "Tampered prebuilt rusty_v8 binary"). CI does the download itself instead:

```
archive=$(ops/v8-archive.sh fetch x86_64-unknown-linux-gnu "$RUNNER_TEMP/rusty_v8")
export RUSTY_V8_ARCHIVE=$archive   # the build script copies this file, no download
cargo build ...
```

`fetch` reads the single `v8` version from `Cargo.lock` (two versions are an error), looks up the one archive for that version and target in `v8-checksums.txt`, downloads it, and fails with `checksum mismatch` before cargo runs if the sha256 differs. A version or target without an entry also fails, so a `v8` bump cannot reach CI unverified.

`RENOX_V8_MIRROR` points `fetch` at a mirror with the upstream layout (`<base>/v<version>/<archive>`), for example our object storage once it exists; the default is `https://github.com/denoland/rusty_v8/releases/download`. It is deliberately not `RUSTY_V8_MIRROR`, which the `v8` build script reads to download further files unverified.

Local builds still let the build script download the archive; set `RUSTY_V8_ARCHIVE` from `fetch` the same way to verify it locally.

### Adding a `v8` version or a target

1. Find the archive name: `librusty_v8` + the enabled feature suffixes in this order (`_ptrcomp`, `_sandbox`, `_simdutf`; see `cargo tree -e features -i v8`) + `_release_<target>.a.gz`. Today it is `librusty_v8_simdutf_release_<target>.a.gz`.
2. Download it from `https://github.com/denoland/rusty_v8/releases/download/v<version>/<archive>` twice, from two different networks or machines, and check both give the same `sha256sum`. Upstream publishes no checksum file, so this first download is trusted; record where it came from in the PR.
3. Add the line `<sha256>  v<version>/<archive>` to `v8-checksums.txt` and remove the lines of versions no longer in `Cargo.lock`.
4. Bump the `v8` (and the Deno crates) in the same PR; Dependabot leaves them alone (`.github/dependabot.yml`).

Current entries, all `v150.4.0`, one per target the worker release builds or will build:

| Archive | Added | Downloads |
| --- | --- | --- |
| `librusty_v8_simdutf_release_x86_64-unknown-linux-gnu.a.gz` | 2026-10-27 (#109) | twice, same sha256, both from the same build container (one network) |
| `librusty_v8_simdutf_release_aarch64-unknown-linux-gnu.a.gz` | 2026-10-29 (#139) | twice, same sha256 |
| `librusty_v8_simdutf_release_aarch64-apple-darwin.a.gz` | 2026-10-29 (#139) | twice, same sha256 |
| `librusty_v8_simdutf_release_x86_64-apple-darwin.a.gz` | 2026-10-29 (#139) | twice, same sha256 |

A second-network check is still owed for all four. `release-worker.yml` builds all four targets since #212 landed the macOS CPU-clock wall-time cross-check: within a slice the isolate thread holds V8 and runs JavaScript, so wall is a tight upper bound on CPU and does not lag like `thread_info(THREAD_BASIC_INFO)`.

## Worker nodes

Every node is set up from this directory by `scripts/bootstrap-node.sh`; nothing is configured by hand (until F6 nodes were set up by hand, `bench/README.md`). The isolation hierarchy is `docs/04-isolation-security.md`, "Isolation hierarchy": one Rust process tree per node; the free tier shares one process, the paid tier gets one process per tenant; cgroups cap CPU, memory and pids.

### Layout

| Path | Owner, mode | What it holds |
| --- | --- | --- |
| `/opt/renox/bin/renox-worker` | root, 0755 | The worker release (SHA-256 verified like `cli/scripts/fetch-worker.ts`); `renox-worker.prev` is the previous one, for rollback |
| `/opt/renox/bin/litestream` | root, 0755 | The Litestream of `litestream.lock` |
| `/opt/renox/worker-version` | root, 0644 | The installed worker version; `bootstrap-node.sh` refuses another without `--upgrade` |
| `/etc/renox/worker.toml` | root:renox, 0640 | From `worker.toml.example`, written once |
| `/etc/renox/node.token`, `platform.key` | renox:renox, 0400 | The node token (`renox_node_…`) and the platform key (32 random bytes, generated once). The worker runs as `renox` and refuses either file with any group or other bit; `bootstrap-node.sh` sets both to renox:renox 0400 on every run (#393) |
| `/var/lib/renox-acme-challenges` | renox-control:renox, 2750 | Single host only: the ACME HTTP-01 challenges the control API writes (`CONTROL_ACME_CHALLENGE_DIR`) and the worker serves (`[tls] acme_dir`); setgid, so every file has the group `renox` (#397) |
| `/var/lib/renox/data/<tenant>/app.db` | renox, 0750 | Tenant files; `_certs/` for TLS |
| `/var/lib/renox/{artifacts,meters,logs,spool,replica}` | renox, 0750 | Artifact cache, meter batches, tenant logs, the control-plane spool, the `file` replica of tests and single-node setups |
| `/run/renox/` | renox, 0750 | Runtime: `children/<tenant>.sock` (#254), `litestream/<db>.yml` (#255); kept across a worker restart |
| `/etc/systemd/system/renox-*` | root, 0644 | The units of `systemd/` |

### Units

| Unit | Slice | What it does |
| --- | --- | --- |
| `renox-node.target` | — | Everything below; `systemctl enable --now renox-node.target` |
| `renox-worker.service` | `renox-free.slice` | The worker: gateway, supervisor (#254) and the shared process of the free tier. User `renox`, `NoNewPrivileges`, `ProtectSystem=strict` with `ReadWritePaths` on the data, artifacts, meters, logs, spool and replica dirs only, `PrivateTmp`, `ProtectKernelTunables`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `SystemCallArchitectures=native`, `Delegate=yes` so the supervisor can create child cgroups under its own (`[process] launcher = "direct"`), and `CAP_NET_BIND_SERVICE` as its one ambient and bounding capability, so `renox` binds 443 and 80 (#394). Its own seccomp and Landlock profile is `[sandbox]` (#253) |
| `renox-child@<tenant>.service` | `renox-paid.slice` | One paid tenant's child worker (`--child <tenant>`), started by the supervisor with `[process] launcher = "systemd"`; `MemoryMax=1G`, `TasksMax=512`, `CPUQuota=200%`; writes only its own tenant dir |
| `renox-control.service` | — | Single host only (#366): `control/api` on Bun as `renox-control`, `EnvironmentFile=/etc/renox/control.env`, both listeners on loopback; exit 78 (a refused configuration) is not restarted. `UMask=0027` and `ReadWritePaths=/var/lib/renox-acme-challenges`, so the worker can read the challenges it writes (#397) |
| `renox-tunnel.service` | — | Single host only: `cloudflared` as a dynamic user, its config and credentials by `LoadCredential` |
| `renox-cert-renew.service`, `.timer` | — | Single host only: `renew-wildcard-cert.sh` daily, the DNS token by `LoadCredential`; reloads the worker only when it is active (#399) |
| `renox-backup-db.service`, `.timer` | — | Single host only: `backup-control-db.sh` nightly as `postgres`, the R2 keys and the age public key by `LoadCredential` (systemd 255 hands them over as root 0440, which the script accepts in `$CREDENTIALS_DIRECTORY` only, #395) |
| `renox-litestream@<db>.service` | `renox-free.slice` | One Litestream sidecar per tenant file (#255), `litestream replicate -config /run/renox/litestream/<db>.yml`; writes only the replica dir and the `-litestream` shadow next to the file |
| `renox.slice` | — | Parent of both tiers: 90 % of RAM, 65,536 tasks |
| `renox-free.slice` | `renox.slice` | `CPUWeight=100`, `MemoryMax=50%`, `TasksMax=16384`: what all free tenants together take |
| `renox-paid.slice` | `renox.slice` | `CPUWeight=200`, `MemoryMax=80%`, `TasksMax=32768` |

Per-request limits (CPU per request, heap, wall-clock, concurrency) are enforced in Rust, not here; the slices only stop one tier from starving the other or the host.

### Reading the cgroup accounting

- `systemd-cgtop renox.slice` shows CPU, memory, tasks and I/O per slice and unit, live; `-m` sorts by memory.
- `systemctl status renox-free.slice renox-paid.slice` shows the tree with the processes; `systemctl show -p MemoryCurrent,TasksCurrent,CPUUsageNSec renox-paid.slice` the totals.
- A paid tenant: `systemctl status renox-child@<tenant>` (or, with the `direct` launcher, `cat /sys/fs/cgroup/renox.slice/renox-free.slice/renox-worker.service/paid/renox-<tenant>.scope/memory.current`).
- `memory.events` (`oom_kill`) and `pids.events` (`max`) of a unit's cgroup count limit hits; they are what #104's chaos harness reads.

### Setting up a node

```
sudo ops/scripts/bootstrap-node.sh --worker-version 0.3.0 \
  --node-id node-dxb-01 --control-url https://10.0.1.5:8788 --region me-central-1 \
  --blocked-addresses 203.0.113.10,10.0.1.5 --node-token-file ./node.token
```

The node token comes from `POST /v1/admin/nodes`. `--blocked-addresses` are the node's own public addresses and the control plane's node-facing ones (ADR D23); the worker refuses to start without them.

### Upgrade

1. Read the release notes; check that `ops/` of the release's commit matches what is installed (`diff -r ops/systemd /etc/systemd/system/renox-*`).
2. `sudo ops/scripts/bootstrap-node.sh --worker-version <new> --upgrade` (same other flags). It verifies the new binary's SHA-256, keeps the old one as `/opt/renox/bin/renox-worker.prev`, reinstalls the units, and restarts `renox-worker`; in-flight requests drain for up to 130 s (`TimeoutStopSec`). `worker.toml` is not touched: compare it with `worker.toml.example` by hand.
3. Check `systemctl is-active renox-worker`, `journalctl -u renox-worker -n 50`, and the node's heartbeat in the control plane.

### Rollback

1. `sudo install -m 0755 /opt/renox/bin/renox-worker.prev /opt/renox/bin/renox-worker`
2. `echo <previous version> | sudo tee /opt/renox/worker-version`
3. `sudo systemctl restart renox-worker`

Forward-only migrations (D17) mean a rollback never undoes a tenant migration; the older worker must be able to open files the newer one wrote (both use the same SQLite).

## Litestream

`litestream.lock` pins one release for every node and for CI (the `rust` job puts it on `PATH`, so `renox-cell`'s replication tests run). 0.3.x is pinned on purpose: the deploy API 0.3 exposes Litestream generations, which 0.5 replaced.

To bump it: download the tarball for each target from `https://github.com/benbjohnson/litestream/releases/download/v<version>/` twice, from two networks, check both give the same `sha256sum`, update `version` and the lines in `litestream.lock`, and run `ops/scripts/fetch-litestream.test.sh` and the replication tests. The 0.3.13 entries were downloaded twice from the same build container (one network) on 2026-10-29; a second-network check is owed, as for the V8 archives.

## Moving a tenant to a microVM

An operator moves a tenant with `POST /v1/ops/tenants/{tenant_id}/move` and `{ "target": "microvm", "reason": … }` (deploy-api.md section 17, #259). The control plane marks the tenant `moving` and calls the owning node's listener (`POST /nodes/{node}/tenants/{tenant}/move`). The node then:

1. answers 503 `RENOX_TENANT_MOVING` for the tenant and drains its cells;
2. runs `[process] microvm_hook` with the tenant id and the absolute path of its file, with an empty environment (`PATH` only) and a 10-minute timeout;
3. reports the hook's exit code.

Exit 0 means moved: the node keeps refusing the tenant, and the control plane records the move. Any other code means failed: the tenant serves where it was. A node without a hook answers 75 without running anything.

`scripts/move-to-microvm.sh` is the hook in F6, a documented stub. It prints the plan a Firecracker launcher would follow: a `VACUUM INTO` snapshot of the drained file, a VM started from the renox-worker image with the copy as its disk, the VM's worker registering as a node, and the control plane pinning the tenant to it. With `--dry-run` it exits 0; otherwise it exits 75 (`EX_TEMPFAIL`), so a real move fails safely and the tenant stays on its node. `scripts/move-to-microvm.test.sh` checks both codes. To try the flow on a node, set:

```toml
[process]
microvm_hook = "/opt/renox/ops/scripts/move-to-microvm.sh"
```

With `[sandbox]` on, the hook inherits the worker's seccomp filter (#253). That filter has no fork: no `fork`, no `vfork`, no `clone` without thread flags. So a hook may use only shell builtins (`printf`, `[ ]`, `read`, `exit`) and must start a launcher with `exec`, never as a child; `sleep`, a pipe, or `$(…)` would kill it. Killed by the filter, the hook exits with 128 + 31 (`SIGSYS`), which counts as failed, so the tenant serves where it was. The stub stays within these rules, and so does the hook of `crates/renox-cell/tests/move_hook.rs`, which CI runs under `RENOX_TEST_SANDBOX=enforce`.

The real launcher (the Firecracker image, its network, and the route to a VM) is F7 work. It replaces this script behind the same interface: two arguments in, one exit code out.

## Single host

`single-host.md` is the runbook: the worker, the control plane, Postgres and a Cloudflare Tunnel on one machine (#366). `bootstrap-node.sh --single-host` installs the extra binaries, units, user and templates; the owner fills in the secrets.

Tests, all without network or accounts:

| Test | Runs in | Proves |
| --- | --- | --- |
| `fetch-cloudflared.test.sh`, `fetch-lego.test.sh` | CI ops step | A binary or tarball matching the lock is installed; one changed byte, another hash in the lock, an unknown target are refused and leave nothing behind |
| `renew-wildcard-cert.test.sh` | CI ops step | A fake lego: a group-readable token file is refused; both CertStore directories written; reload only on a change; a certificate without the apex or with another key is refused; the token never in argv, environment or output; with a fake `systemctl`, an inactive worker is not reloaded and the run succeeds, an active one is, and the "installed" line comes first (#399) |
| `backup-control-db.test.sh` | CI ops step | A fake S3 that verifies each request's SigV4 signature: the object decrypts to the dump and is not it in the clear; a failing `pg_dump` uploads nothing; bad credentials files are refused, including 0440 outside `$CREDENTIALS_DIRECTORY`, not owned by root, or with an other bit (#395); the secret never in curl's argv |
| `production-install.test.sh` | Called by `bootstrap-node.test.sh` when Bun is present | Step 3 of `single-host.md` (#400): `bun install --frozen-lockfile --production` on the tracked files succeeds with a PATH that holds no other `tsc`; the SDK's `prepare` skips its build there; the control API's imports resolve except `@electric-sql/pglite` (a `control/api` dev dependency, still open on #400); a dev install still builds `sdk/dist` |
| `firewall-single-host.test.sh` | CI ops step (two containers) | Refuses without sshd, with sshd on another port, from a session on another port, with a bad `--ssh-port`; once applied 22, 80, 443 answer from outside and 8787, 5432 do not; a second run is a no-op; `--ssh-port 49222` opens 49222 and closes 22 |
| `bootstrap-node.test.sh` | CI rust job (systemd container) | `--single-host`'s refusals, the worker.toml it writes (parsed by the real worker), files and modes; `node.token` and `platform.key` renox:renox 0400, and 0640 ones corrected (#393); the real single-host worker (controlled, sandbox on) starting with the installed files and binding 443 and 80 with `ip_unprivileged_port_start` back at Ubuntu's 1024, holding only `CAP_NET_BIND_SERVICE` (#394); a challenge written under `renox-control.service`'s own sandbox served on :80 (#397); `renox-tunnel`, `renox-cert-renew` (also the first install with the worker stopped, #399) and `renox-backup-db` as `postgres` (#395) with `LoadCredential`, after `mount --make-rshared /` so the container's systemd provides credential directories as the host's does; `renox-control` on loopback only and its refusal of `0.0.0.0`; `production-install.test.sh` |

### cloudflared and lego

Bump like Litestream: download the new release twice (two networks if possible), check both give the same `sha256sum` (for lego, also against upstream's `lego_<version>_checksums.txt`), replace the version and the lines in the lock, and run both fetch tests. lego stays on v4: `renew-wildcard-cert.sh` uses the v4 command line.
