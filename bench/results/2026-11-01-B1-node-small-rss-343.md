# B1 on `node-small`: per-isolate RSS outside the V8 heap (#343) — 2026-11-01

Hardware: node-small (AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM (7,941 MB), SSD (QEMU virtual disk), Ubuntu 24.04.5, Linux 6.8.0-147-generic; transparent huge pages `madvise`, defrag `madvise`), rustc 1.99.1, bun 1.4.4, glibc malloc.

Workers (release, `CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker`, prebuilt `rusty_v8` 150.4.0):
- `main` 7e84c8e.
- 7e84c8e plus #342's request-path warm-up (this branch).
- dddd743: the commit the dev container measured at 7.33 MB (`2026-10-29-B1-lazy-routes-renox-worker.md`), built on this host on 2026-10-31 and run from a checkout of that commit so the `shop` artifact is that commit's too.

Method: B1's own procedure (`bench/scenarios/B1/worker.ts`) for `shop` (`GET /api/products`) or `hello` at N = 100:
- Start a worker with N tenants.
- Read `/proc/<pid>/smaps_rollup` 3 times before and 5 times after one request per tenant (5 s settle).
- Compute `(after − before) / N` per field and take the median of 3 runs.
- Separately, attribute every mapping of `/proc/<pid>/smaps` to a kind by address, permissions and layout. The glibc arenas are the 64 MiB-aligned `rw-p` + `---p` heaps.
- Pass allocator variants in the worker's environment and check them in `/proc/<pid>/environ`. A first round set them from inside the Bun script, never reached the worker, and was discarded.

## Result

**The host is not the cause.** The commit the dev container measured gives the same number on `node-small`:

| `shop`, N = 100, per isolate | RSS | Anonymous | V8 heap (meter) | Where |
| --- | --- | --- | --- | --- |
| dddd743 | 7.33 MB | — | 4.25 MB | dev container, Linux 6.18, 16 GB (2026-10-29) |
| **dddd743** | **7.32 MB** (7.31–7.32) | 7.09 | 4.25 MB | `node-small` (this file) |
| 1664c60 (O3) | 10.07 MB | — | 4.17 MB | `node-small` (2026-10-30) |
| 7e84c8e | 11.89 MB | 11.59 | 4.47 MB | `node-small` (this file) |
| 7e84c8e + #342 warm-up | 11.91 MB | 11.60 | 4.48 MB | `node-small` (this file) |

`hello` at N = 100: 6.67 MB (7e84c8e + warm-up), 6.63–6.66 MB on 7e84c8e.

The 2.7 MB gap that #343 describes compares two commits: dddd743 on the container against 1664c60 on `node-small`, 131 commits later. In those commits `shop` gained the `2fa`, `audit`, `notifications` and second-phase `auth` modules (F5), and the platform gained OTel, jobs, storage, webhooks, AI and PDF ops (F6, F7). The 75 commits from 1664c60 to 7e84c8e (billing, among others) added 1.8 MB more. Today's worker cannot serve dddd743's `shop` artifact (500 `RENOX_INTERNAL`), so this file does not split the growth into the app's part and the platform's part.

### Where the 11.9 MB goes (7e84c8e + warm-up)

| Kind of mapping (per isolate) | `shop` 7e84c8e | `hello` 7e84c8e | `shop` dddd743 |
| --- | --- | --- | --- |
| other anonymous (V8 heap pages outside the cage reservation and other `mmap`) | 6.21 MB | 3.18 MB | 3.24 MB |
| glibc arenas (live `malloc`) | 3.88 | 1.95 | 2.59 |
| inside V8's pointer-compression cage reservation | 1.27 | 1.06 | 1.06 |
| worker binary (pages touched) | 0.28 | 0.23 | 0.19 |
| thread stacks | 0.10 | 0.10 | 0.10 |
| anonymous `rwx` (V8 code) | 0.08 | 0.05 | 0.05 |
| glibc main heap, libraries and files | 0.11 | 0.10 | 0.08 |
| **total** | **11.93** | **6.66** | **7.32** |

Every isolate adds 3 threads (isolate, watchdog, DB). From dddd743 to 7e84c8e, `shop` grew by 3.0 MB of anonymous memory outside `malloc` and by 1.3 MB of `malloc`. The V8 heap reported by the meter grew by only 0.23 MB.

### Allocator settings: no effect

| `shop`, 7e84c8e + warm-up, N = 100 | RSS per isolate | glibc arenas before → after |
| --- | --- | --- |
| default | 11.91 MB | 9 → 33 |
| `MALLOC_ARENA_MAX=1` | 11.94 MB | 0 → 0 |
| `MALLOC_ARENA_MAX=2` | 11.88 MB | 1 → 4 |
| `MALLOC_ARENA_MAX=4` | 11.86 MB | 3 → 5 |
| `MALLOC_TRIM_THRESHOLD_=131072 MALLOC_TOP_PAD_=0` | 11.89 MB | 9 → 34 |
| `MALLOC_MMAP_THRESHOLD_=65536` | 11.87 MB | 9 → 32 |

With one arena, all of the allocator's memory moves into the main heap and the total does not change. So the 3.9 MB is live `malloc`, not per-thread arena fragmentation, and `malloc_trim` (#144) has nothing to return while the isolates are warm. `AnonHugePages` is 0 in every run: THP is not involved. File-backed RSS does not grow with N (0.3 MB, the binary's pages).

**Not met: `shop` at N = 100 is 11.9 MB on `node-small`, over the 10 MB target and inside the 20 MB limit. No allocator setting brings it under.** The cause is growth of `shop` and of the platform between dddd743 (7.32 MB) and today, not the kernel. Finding it needs a bisect of those 206 commits with a worker and artifact from each, which is outside this issue's files (`alloc.rs`, the binary's allocator settings). The comparison on the dev container itself was not run: this session has `node-small` only. The same commit (dddd743) was measured on both, by the container's earlier file and by this one.

Raw: `bench/results/raw/2026-11-01-B1-node-small-rss-343.json` (every run's `smaps_rollup` deltas, the region breakdowns, and both scripts).

## Raw command lines

```
# B1 itself (#342's acceptance attempts give the B1 numbers of both workers): bench/results/2026-11-01-cold-request-cpu-node-small.md
# smaps_rollup per variant, 3 runs each (rss.ts in the raw file), run from the checkout whose shop is measured
RENOX_WORKER_PATH=<worker> APP=shop N=100 RUNS=3 VARIANTS=default bun rss.ts out.json
env MALLOC_ARENA_MAX=1 RENOX_WORKER_PATH=<worker> APP=shop N=100 RUNS=3 VARIANTS=default bun rss.ts out.json     # likewise =2, =4, the trim and mmap thresholds
# per-region breakdown (regions.ts in the raw file)
RENOX_WORKER_PATH=<worker> APP=shop N=100 bun regions.ts out.json
```
