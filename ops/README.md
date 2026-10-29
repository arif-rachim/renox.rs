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
| `scripts/*.test.sh` | `fetch-litestream.test.sh` (CI lint job, no network) and `bootstrap-node.test.sh` (CI rust job: a systemd container with the worker just built) |

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

A second-network check is still owed for all four. The macOS archives are verified by `ops/v8-archive.sh` but not yet used by a release: `release-worker.yml` builds the two Linux targets until the macOS CPU-clock issue is fixed (#139).

## Worker nodes

Every node is set up from this directory by `scripts/bootstrap-node.sh`; nothing is configured by hand (until F6 nodes were set up by hand, `bench/README.md`). The isolation hierarchy is `docs/04-isolation-security.md`, "Isolation hierarchy": one Rust process tree per node; the free tier shares one process, the paid tier gets one process per tenant; cgroups cap CPU, memory and pids.

### Layout

| Path | Owner, mode | What it holds |
| --- | --- | --- |
| `/opt/renox/bin/renox-worker` | root, 0755 | The worker release (SHA-256 verified like `cli/scripts/fetch-worker.ts`); `renox-worker.prev` is the previous one, for rollback |
| `/opt/renox/bin/litestream` | root, 0755 | The Litestream of `litestream.lock` |
| `/opt/renox/worker-version` | root, 0644 | The installed worker version; `bootstrap-node.sh` refuses another without `--upgrade` |
| `/etc/renox/worker.toml` | root:renox, 0640 | From `worker.toml.example`, written once |
| `/etc/renox/node.token`, `platform.key` | root:renox, 0640 | The node token (`renox_node_…`) and the platform key (32 random bytes, generated once) |
| `/var/lib/renox/data/<tenant>/app.db` | renox, 0750 | Tenant files; `_certs/` for TLS |
| `/var/lib/renox/{artifacts,meters,logs,spool,replica}` | renox, 0750 | Artifact cache, meter batches, tenant logs, the control-plane spool, the `file` replica of tests and single-node setups |
| `/run/renox/` | renox, 0750 | Runtime: `children/<tenant>.sock` (#254), `litestream/<db>.yml` (#255); kept across a worker restart |
| `/etc/systemd/system/renox-*` | root, 0644 | The units of `systemd/` |

### Units

| Unit | Slice | What it does |
| --- | --- | --- |
| `renox-node.target` | — | Everything below; `systemctl enable --now renox-node.target` |
| `renox-worker.service` | `renox-free.slice` | The worker: gateway, supervisor (#254) and the shared process of the free tier. User `renox`, `NoNewPrivileges`, `ProtectSystem=strict` with `ReadWritePaths` on the data, artifacts, meters, logs, spool and replica dirs only, `PrivateTmp`, `ProtectKernelTunables`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `SystemCallArchitectures=native`, `Delegate=yes` so the supervisor can create child cgroups under its own (`[process] launcher = "direct"`). Its own seccomp and Landlock profile is `[sandbox]` (#253) |
| `renox-child@<tenant>.service` | `renox-paid.slice` | One paid tenant's child worker (`--child <tenant>`), started by the supervisor with `[process] launcher = "systemd"`; `MemoryMax=1G`, `TasksMax=512`, `CPUQuota=200%`; writes only its own tenant dir |
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
