# B14 — Memory of idle WebSocket connections on `node-small` (#522) — 2026-11-07

Hardware: node-small (AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM (7,941 MB), Linux 6.8.0-147-generic; a shared-vCPU KVM guest without steal accounting, `bench/results/2026-11-05-cpu-stalls-node-small.md`), rustc 1.99.1, bun 1.4.4.

Worker: `renox-worker` release built on the host from `main` 0344a48 (`CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker`, 46 min 38 s); git of the run 1f12998 (0344a48 plus #523's docs commit, no code change).

Scenario: `RENOX_WORKER_PATH=<release worker> bench/run.sh B14 --profile node-small --runs 3`. Each run starts a fresh bench worker on a random loopback port with its own data directory (`bench/lib/worker.sh`), one tenant `t_chat` with `examples/chat`; one user signs in, then `bench/lib/ws-load.ts` opens 10,000 sockets to `/ws/chat/general` and holds them 10 s. RSS is the bench worker's `VmRSS` after warm-up and after the hold; the isolate heap is the smallest `peak_heap_bytes` of the page requests before and after. The load generator runs on the same host (provisional, #456 decided by D31): it is `bun`, on the same 4 vCPUs. The production worker, control plane and tunnel of the host kept serving; they were watched throughout (section 3).

**Change to the scenario (this issue):** `bench/scenarios/B14/run.sh` gives the bench tenant's free tier `cpu_ms = 1000` (`B14_FREE_CPU_MS`, default 1000). The first attempt stopped before any socket opened: the cold `GET /auth/register` of a fresh worker was charged 55.0 ms against 50 ms (`RENOX_CPU_LIMIT`, the host-stall gap of #523), and the sign-in that followed answered 503. B14 judges memory, so the CPU limit is lifted for the bench tenant only.

## 1. Result

| Run | Open 10,000 sockets | RSS before | RSS after | Delta | Per connection | Isolate heap delta |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 14.6 s | 97.0 MB | 341.6 MB | 244.6 MB | 25.0 KB | 3.16 MB |
| 2 | 13.6 s | 97.2 MB | 340.1 MB | 242.9 MB | 24.9 KB | 4.63 MB |
| 3 | 15.7 s | 97.1 MB | 338.7 MB | 241.6 MB | 24.7 KB | 5.36 MB |
| **median** | | | | **242.9 MB** | **24.9 KB** | **4.63 MB** |

All 10,000 sockets opened and were alive at the end in every run; RSS was flat over the hold (ten samples equal per run).

Target ≤ 50 MB total, isolate heap unchanged; fail > 150 MB → **FAIL** (RSS over the red line; heap delta over its 1 MB target, inside its 10 MB limit). Provisional (D31).

It is the dev container's number again: 243.6 MB with a debug build there (`bench/results/2026-10-29-B14-dev-container.md`). A release build does not change it, so the cost is allocated memory, not debug overhead. The `renox-realtime` crate alone holds 10,000 connections in 46.8 MB (4.9 KB each, `bench/results/2026-10-29-B14-crate-dev-container.md`); the worker path adds about 20 KB per connection.

## 2. Where the 20 KB per connection is: not measured yet

The per-connection objects of the worker path (`crates/renox-cell/src/realtime/mod.rs`, the WebSocket branch), read from the code:

- three tokio tasks per connection: the counter task (`hub_rx` → `count_tx`), the connection task holding the realtime session `s` and its `open`/`message`/`close` runs, and `ws::serve`;
- three bounded channels: the hub queue (256), the counted queue of the same capacity, and the inbound channel (16); each tokio `mpsc` allocates a 32-slot block at the first send;
- the upgraded hyper I/O (`hyper::upgrade::Upgraded`, boxed, with its rewind buffer) and `tokio::io::split`;
- the realtime session `s` and the `OwnedInFlight` guard;
- the `open` handler's per-connection state in the isolate (the heap delta: 0.3–0.5 KB per connection).

No allocation profile was taken in this session: `heaptrack` or a `dhat` build needs a package install or another 47-minute build, and the run below cost the host's tunnel a reconnect. The next step is a profile of one worker with 10,000 connections (`/proc/<pid>/smaps` by mapping and a `dhat` or jemalloc profile of the realtime path), then the levers task 2 of #522 names: fold the counter task into `ws::serve` (one task and one channel fewer), size the counted queue lazily, and box the session's run futures.

## 3. The production host during the run

`b14-guard.sh` sampled every 2 s from 12:52:35Z to 12:54:18Z (raw: `bench/results/raw/2026-11-07-B14-guard.json`): the bench worker's RSS (max 346 MB, under the 1.5 GB abort line), the production worker's RSS (154–156 MB, unchanged), established sockets to the bench port (max 10,001), and every 10 s `https://dashboard.renoxium.com/` (303), `https://renoxium.com/` (200), `https://win-smoke-441.renoxium.app/api/health` (200), the worker's `127.0.0.1:9090/healthz` and the control API's `127.0.0.1:8787/v1/healthz`.

Seven of eight platform checks passed. The eighth, at 12:54:16Z, near the end of run 3's hold, timed out on `renoxium.com` and got 502 from `win-smoke-441`; the local health endpoints answered 200. `renox-tunnel`'s journal shows all four QUIC connections to Cloudflare dropped at 12:54:10–11Z ("failed to accept QUIC stream: timeout: no recent network activity") and registered again at 12:54:12–17Z: about 6 s without the tunnel. The same message appears without load on 2026-11-06 23:24Z and 2026-11-07 12:06Z, but four connections at once, during the hold with 10,000 loopback sockets and the load generator on the same vCPUs, is most likely caused by this run. The guard aborts after two failed checks in a row; the run ended at 12:54:18Z before a second check.

After the run: no bench worker or `ws-load` process left, 0 established sockets to the bench port, every platform check 200/303 again.

**Consequence for re-runs:** B14 at 10,000 connections should not run on the production host again while it serves users, or should run with the load generator on another machine (#456, deferred by D31). A smaller N (`B14_CONNECTIONS`) gives the per-connection number without the full load.

## Status

#522: B14 measured on `node-small` with a release worker: FAIL (242.9 MB, 24.9 KB per connection). The fix (task 2) and the second PASS run (task 3) are open.

Raw: `bench/results/raw/2026-11-07-B14.json` (summary), `.run-1..3.json` (each run), `.hw.json`, `2026-11-07-B14-guard.json` (the production watch).
