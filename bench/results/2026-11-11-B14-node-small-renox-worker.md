# B14 — 10,000 idle WebSocket connections on `node-small`, release `renox-worker` 0.7.1 (#522, task 1) — 2026-11-11

| | |
| --- | --- |
| Host | `node-small`: AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM (7941 MB), Linux 6.8.0-147-generic, Ubuntu 24.04 KVM VPS. It is the production single host, and it served live tenants during the run. |
| Build | released `renox-worker` 0.7.1 (`worker-v0.7.1`, x86_64-unknown-linux-gnu, default variant), from `bun cli/scripts/fetch-worker.ts 0.7.1`, sha256 `1453a8d19c2d…` = the CLI's pin. Not built from source. It contains #680 (PR #712, merged 2026-11-10, an ancestor of `worker-v0.7.1`). |
| Checkout | `f21a6b41` (`origin/main`), a separate worktree; the deployed checkouts were not used. |
| Scenario | `RENOX_WORKER_PATH=<0.7.1> bench/run.sh B14 --profile node-small --runs 3` (10 s hold), and one run with `B14_HOLD_S=30` |
| Run | 2026-11-10 23:20–23:22 UTC, bun 1.4.4 |
| Load generator | `bench/lib/ws-load.ts` on the same host. There is no second host (#456; deferred by #516). It is provisional by #522: the CPU it took is recorded below. |
| Decision | owner, #716 (2026-11-10): run on `node-small` with the current worker and decide the gap on this number |

## Result

| Run | RSS before | RSS after | RSS delta | Heap delta | Opened / alive at the end |
| --- | --- | --- | --- | --- | --- |
| 1 (10 s) | 70.8 MB | 154.8 MB | 83.9 MB | −0.48 MB | 10,000 / 10,000 |
| 2 (10 s) | 71.2 MB | 156.3 MB | 85.1 MB | −0.70 MB | 10,000 / 9,975 |
| 3 (10 s) | 70.9 MB | 156.4 MB | 85.5 MB | −0.51 MB | 10,000 / 10,000 |
| **median** | | | **85.1 MB** | **−0.51 MB** | |
| 30 s hold | 70.7 MB | 163.0 MB | 92.3 MB | −0.92 MB | 9,957 (43 failed) / 9,921 |

| | 10 s hold | 30 s hold |
| --- | --- | --- |
| RSS delta in the 30 s run, at 10 s / at 30 s | 92.3 MB | 92.3 MB |
| Absolute RSS, at 10 s / at 30 s | 163.0 MB | 163.0 MB |

In every run, RSS peaks while the connections open (197–218 MB), then falls within 2 to 3 s to its hold value. After that it does not move: in the 30 s run it is the same at 10 s and at 30 s. The isolate heap is unchanged (−0.5 MB). The connections live in the Rust hub, as in every earlier run.

Run 2 lost 25 connections, and the 30 s run failed to open 43 and lost 36 more. The deltas are for fewer than 10,000 connections there. Per open connection the 30 s run is 9.5 KB and the median run 8.5 KB.

**Verdict against `docs/14-benchmarks.md`** (target ≤ 50 MB, red line > 150 MB): **85.1 MB, under the red line, over the target.** It is 35.1 MB over the target, at about 8.5 KB per connection. `bench/lib/report.sh` prints FAIL because it knows only the target. The heap condition ("isolate heap unchanged") holds.

## Load generator and host during the run

`pidstat -u -h -l 1` over the whole run (raw sample per second, 4 vCPU = 400 %):

| Process | While the 10,000 connections open (about 6 s) | During the hold |
| --- | --- | --- |
| load generator (`bun bench/lib/ws-load.ts`) | 35–60 % (of one CPU) | 1–2 % |
| bench `renox-worker` 0.7.1 | 200–280 % | 1 % |
| production `renox-worker`, `renox-control`, `cloudflared` | each under 16 %, mean 2–2.5 % | the same |

The generator shares the 4 vCPU with the worker only while connections open. During the hold, which is when the RSS is read, it is idle. So it does not affect the number that is judged, but it does slow the opening, which takes 5.8–9.1 s. The failed and dropped connections of run 2 and the 30 s run happened while the host also served production traffic. Memory available was 6752 MB before the run and 6496 MB during it.

## Against the dev container

| Where | Worker | Median (10 s) | 30 s hold |
| --- | --- | --- | --- |
| dev container (Xeon, 16 GB, Linux 6.18) | #680 task 3, release build from source | 81.4 MB | 80.6 MB |
| **`node-small`** | **released 0.7.1** | **85.1 MB** | **92.3 MB** |

The dev-container number holds on `node-small` within 4 MB at 10 s. Two differences remain, and this run cannot separate them:

- The CLI pins worker 0.7.1, and since f136974 `renox build` writes lazy module entries only for a worker of 0.8.0 or later. These artifacts were therefore built eager. The dev-container runs predate that gate, and built lazy.
- The host is different: another kernel, another CPU, and production traffic alongside.

The 30 s run is 7 MB higher than the 10 s median. It is one run; it is not a trend over the hold, since its own RSS is flat from second 3 to second 30.

## What was not touched

The benchmark started its own `renox-worker` from `cli/bin/linux-x64/renox-worker`. Its `worker.toml` was in a `mktemp -d` directory, with a random port on 127.0.0.1 and no `[control]` section, so it had no health port and made no control-plane connection. `bench/lib/worker.sh stop` stopped it by its own pid file. The production services `renox-worker`, `renox-control`, `renox-tunnel` and Postgres were not stopped, restarted or reconfigured, and `/var/lib/renox`, `/etc/renox` and `/opt/renox` were not read or written.

Raw: `bench/results/raw/2026-11-11-B14-node-small*.json` (10 s), `bench/results/raw/2026-11-11-B14-node-small-hold30*.json` (30 s).
