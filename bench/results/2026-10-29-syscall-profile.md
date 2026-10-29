# Syscall profile of renox-worker (#253)

| | |
| --- | --- |
| Date | 2026-10-29 |
| Host | dev container, 4 vCPU, Ubuntu 24.04.5, glibc 2.39, kernel 6.18.44 (x86_64); Landlock file-system rules partially enforced, network rules (ABI 4) enforced |
| Commit | batch F6-ALL branch, before the PR |
| Tool | `ops/scripts/trace-syscalls.sh` (`strace -f -qq -c`), then `--from-traces` after `sandbox/baseline.txt` was reviewed |
| Output | `crates/renox-cell/sandbox/syscalls.x86_64.txt` (traced), `syscalls.aarch64.txt` (derived) |

## Traced

| What | renox-worker how | Result |
| --- | --- | --- |
| `cargo test -p renox-cell`, all 13 test binaries of that commit (lib, `renox-worker` bin, `actions`, `activation`, `artifact`, `compress`, `controlled`, `degraded`, `errors`, `pages`, `streaming`, `tls_worker`, `two_tenants`) | in-process, and the `renox-worker` binary spawned by `two_tenants` | traced; `controlled` skips its Postgres cases without `RENOX_TEST_PG` |
| `bun test cli/tests/deploy.e2e.test.ts` | a controlled `renox-worker` behind a `RENOX_WORKER_PATH` wrapper running `strace` | traced, passed |
| `bench/run.sh B15 --runs 1` (deploy to first 200, rollback) | the same wrapper | traced, passed |

## Not traced, and why

| What | Why | Owed by |
| --- | --- | --- |
| `bench/run.sh B8` and every load-generator scenario (B1, B2, B3, B4, B6, B9, B11, B12) | `oha` / `wrk` are not installed on the dev container (`bench/scenarios/README.md`: installed by hand) | O3 (#158) on `node-small`: run `ops/scripts/trace-syscalls.sh` there and diff |
| `bun test cli/tests/dev.e2e.test.ts`, `bench/run.sh B16` | Failed under `strace`: the template-edit step races the slowed-down worker (fragment still shows v1); the same tests are not affected by the sandbox itself, which only `renox-worker` with `[sandbox] enabled` applies | Re-trace with a longer reload wait |
| aarch64 | No arm64 host; the list is derived from x86_64 by the mapping in the script | The first arm64 node (#139 builds) |
| Litestream sidecars | Not traced in the first run (running the binary was not allowed then); traced in the amendment below | — |

## Result

| Architecture | Syscalls | Of which traced | From `baseline.txt` |
| --- | --- | --- | --- |
| x86_64 | 91 | 81 | 10 (`exit`, `exit_group`, `rt_sigreturn`, `restart_syscall`, `execve`, `wait4`, `kill`, `pidfd_open`, `tgkill`, `pipe2`, `dup3`, `waitid`, `close_range`, `getcwd`, `nanosleep`; some were also traced) |
| aarch64 | 92 | derived | — |

Amended for #259 (the `[process] microvm_hook`): CI's `RENOX_TEST_SANDBOX=enforce` run showed a hook started by the worker is killed, because it inherits the filter. `sh` reads its identity at start. `baseline.txt` gained `getuid`, `getgid`, `getegid`, `getppid` and `getpgrp`, all read-only, and both lists were updated the way `--from-traces` would update them. x86_64 now has 96 calls and aarch64 97 (`getpgrp` is `getpgid` there; the script's mapping table has the pair). Fork (`clone` without thread flags, `fork`, `vfork`) stays out, so a hook must use shell builtins or `exec` its launcher. `ops/scripts/move-to-microvm.sh` and the hook of `crates/renox-cell/tests/move_hook.rs` were traced: nothing outside the list.

Amended for the Litestream sidecars (#255). In CI's `enforce` run, a sidecar started by the worker was killed by the filter, and replication silently did nothing. The pinned Litestream 0.3.13, verified against `ops/litestream.lock`, was then traced with `strace -f` through `replicate` (with writes, a checkpoint and `SIGTERM`), `snapshots`, `wal` and `restore` (with and without `-timestamp`). A Go program built here was also run under the filter. What they need beyond the worker's own list:

- `clone` with `CLONE_THREAD` (Go's threads). It is added in `src/sandbox/seccomp.rs` as an argument rule, not as a list entry, so `clone` without that flag (a fork) is still killed.
- `epoll_pwait`, `mkdirat`, `renameat`, `readlinkat`, `fchownat`, `statfs`, `getrlimit`, added to `baseline.txt` with their reasons.

Then CI's runner killed the sidecar on one more call, `getpeername`, which this host's trace never showed. The kernel's audit record (type=1326, syscall 52) named it; the rust job now prints those records when it fails. x86_64 now has 104 calls and aarch64 101. Under `RENOX_TEST_SANDBOX=enforce` with Litestream on `PATH`: `cargo test -p renox-cell` passed 126, failed 0, including all 6 tests of `tests/replication.rs`.

Never in either list (a unit test enforces it): `ptrace`, `process_vm_readv`/`writev`, `bpf`, `mount`, `umount2`, `init_module`, `finit_module`, `kexec_load`, `setns`, `unshare`, `pivot_root`, `chroot`, `keyctl`, `add_key`, `perf_event_open`, `userfaultfd`, `open_by_handle_at`, and `seccomp` itself (a second filter cannot be loaded once the first is in place).

## Runs under `enforce`

| Run | Result |
| --- | --- |
| `RENOX_TEST_SANDBOX=enforce cargo test -p renox-cell` (allowlist loaded into the test process, kill on a miss) | 92 passed, 0 failed, 15 binaries |
| `cargo test -p renox-cell --test sandbox` (real binary, Landlock + seccomp, `enforce`) | 2 passed: `/etc/passwd` → EACCES, `connect(169.254.169.254:80)` → EACCES, artifacts and data dirs usable; a tenant with a migration and SQLite writes served three times |
| `renox-worker --sandbox-selftest` | `landlock fs partial, landlock net full, seccomp 91 syscalls (Enforce)`; both must-refuse probes refused |

Verdict: the profile holds on this host for everything that could be run here. The scenarios that need a load generator, and arm64, are open for O3.
