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
| Litestream sidecars | `litestream` cannot run in this session; a sidecar started by the worker inherits the filter | #255 on CI (Litestream on `PATH`), or the systemd launcher |

## Result

| Architecture | Syscalls | Of which traced | From `baseline.txt` |
| --- | --- | --- | --- |
| x86_64 | 91 | 81 | 10 (`exit`, `exit_group`, `rt_sigreturn`, `restart_syscall`, `execve`, `wait4`, `kill`, `pidfd_open`, `tgkill`, `pipe2`, `dup3`, `waitid`, `close_range`, `getcwd`, `nanosleep`; some were also traced) |
| aarch64 | 92 | derived | — |

Never in either list (a unit test enforces it): `ptrace`, `process_vm_readv`/`writev`, `bpf`, `mount`, `umount2`, `init_module`, `finit_module`, `kexec_load`, `setns`, `unshare`, `pivot_root`, `chroot`, `keyctl`, `add_key`, `perf_event_open`, `userfaultfd`, `open_by_handle_at`, and `seccomp` itself (a second filter cannot be loaded once the first is in place).

## Runs under `enforce`

| Run | Result |
| --- | --- |
| `RENOX_TEST_SANDBOX=enforce cargo test -p renox-cell` (allowlist loaded into the test process, kill on a miss) | 92 passed, 0 failed, 15 binaries |
| `cargo test -p renox-cell --test sandbox` (real binary, Landlock + seccomp, `enforce`) | 2 passed: `/etc/passwd` → EACCES, `connect(169.254.169.254:80)` → EACCES, artifacts and data dirs usable; a tenant with a migration and SQLite writes served three times |
| `renox-worker --sandbox-selftest` | `landlock fs partial, landlock net full, seccomp 91 syscalls (Enforce)`; both must-refuse probes refused |

Verdict: the profile holds on this host for everything that could be run here. The scenarios that need a load generator, and arm64, are open for O3.
