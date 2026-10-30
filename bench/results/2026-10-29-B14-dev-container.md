# B14 — Memory of idle WebSocket connections (#282) — 2026-10-29
Hardware: dev-laptop profile, run in the cloud dev container (Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v185), git 1dcae3d, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: 10,000 idle WebSocket connections on one tenant. `examples/chat` on `renox-worker`, built in debug, with a fresh worker per run. One user signs in, then `bench/lib/ws-load.ts` opens 10,000 sockets to `/ws/chat/general` in batches of 500. Each socket passes the route's guard (`room.enter`), `open` (`room.join`, then a subscribe to `room:general`) and stays idle; they are held 10 s.
- **RSS**: the worker's `VmRSS` after warm-up (five page requests and one socket) and after the hold.
- **Isolate heap**: the smallest `peak_heap_bytes` of five `GET /rooms/:room` meter records before and after.

Result: rss_delta_mb 243.6 MB (median of 239.5, 243.6 and 245.1), heap_delta_mb 7.18 MB (median of 6.63, 7.18 and 8.65); all 10,000 sockets opened and stayed open in every run (8.7 s to open)
Target: ≤ 50 MB total; isolate heap unchanged (fail: > 150 MB) → FAIL in this container
Notes: profile dev-laptop, runs 3; not node-small, so a relative data point, not the gate's verdict. The worker is a debug build: the container had too little disk for a release build of the workspace. Raw: `bench/results/raw/2026-10-29-B14.json` and `.run-1..3.json`

Verdict: **B14 is not met by this build in the dev container.** 10,000 idle connections add about 244 MB of RSS (≈ 24 KB per connection), over the 150 MB red line. The isolate heap seen by a page grows by about 7 MB after the 10,000 `open` runs.

- **What the numbers say.** Connections work at this scale: no refusal, no drop, a flat RSS over the hold. But the per-connection cost is about five times the target, so fan-out stays outside the isolate while the bookkeeping does not.
- **Where the memory goes: not measured yet.** The candidates are the per-connection buffers of the upgraded HTTP/1 connection and of the WebSocket codec (#167, #278), the per-connection task and channel of the hub, and, for the heap, what each `open` leaves in V8 (the `conn` and `ctx` objects of 10,000 handler runs not yet collected; no GC is forced).
- **Next steps.**
  - A release build on `node-small` is O3 (#158). That run is the gate's verdict.
  - Before it, a heap profile of the worker under this scenario (`bench/run.sh B14`, `B14_CONNECTIONS` to scale) should name the per-connection allocations. The likely levers are smaller codec read buffers for idle sockets and a forced GC before the heap sample.
