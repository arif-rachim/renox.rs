# B13 — Template DoS on `node-small` — 2026-11-01

Hardware: node-small (AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM, SSD, Ubuntu 24.04.5, Linux 6.8.0-147-generic; a KVM VPS), git 46fdfce (`main`), renox-worker release (`deno_runtime` 0.268.0, prebuilt `rusty_v8` 150.4.0), rustc 1.99.1, bun 1.4.4
Scenario (new: `bench/scenarios/B13/`): one renox-worker, two tenants, `evil` and `hello`. Per run: 200 sequential `GET /api/hello` (the probe), then 20 sequential `GET /nested` to `evil` (its template loops over 10,000 × 10,000 cells) with the probe running beside them, one request in flight. Then `evil`'s `GET /api/slow?ms=1` must answer 200, and 200 more probe requests run. 3 runs, each on a fresh worker. Judged: `render_ms`, the median over runs of each run's p50 render time, read from the meter record (`render_ms` is the render time outside `cpu_ms`).

| Run | Render ms p50 / max (meter) | Client ms p50 (loader, marshal, render, HTTP) | Probe p50 before | Probe p50 / p99 during | Probe p50 after |
| --- | --- | --- | --- | --- | --- |
| 1 | 18.75 / 26.57 | 27.54 | 2.363 | 1.848 / 12.53 (n = 246) | 1.978 |
| 2 | 20.14 / 35.01 | 33.04 | 1.971 | 2.017 / 20.16 (n = 246) | 1.824 |
| 3 | 20.78 / 52.54 | 32.20 | 2.364 | 1.918 / 20.24 (n = 252) | 2.104 |
| **Median** | **20.14** / max 52.54 | 32.20 | 2.363 | 1.918 / 20.16 | 1.978 |

Target: stops at fuel within 50 ms; node unaffected (fail: render exceeds 500 ms) → **PASS** (20.14 ms). 59 of 60 attacks stopped within 50 ms of render time; one took 52.54 ms, far inside the 500 ms fail threshold.

- All 60 attacks answered 500 `RENOX_RENDER_LIMIT`. The meter status was `render_limit` 60 times, and the fuel at the stop was 250,000 every time.
- **Node unaffected:** the second tenant's probe p50 did not move during the attack (1.92 ms, against 2.36 before and 1.98 after). Its p99 during the attack was 12.5–20.2 ms; that is about one render (the probe and the attack share the worker's threads), not a stall of the node. `evil` itself was still served after 20 attacks (`/api/slow?ms=1` 200).
- The probe is a single request in flight, so it is not a load test. "Node unaffected" under load (B12-style, with the load generator on its own host) waits for #158.

## Raw command lines

```
export RUSTY_V8_ARCHIVE=$(ops/v8-archive.sh fetch x86_64-unknown-linux-gnu ~/bench-tools/rusty_v8)
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker   # 33.5 min
RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B13 --profile node-small --runs 3   # B13_ATTACKS=20, B13_PROBES=200 (defaults)
```

Ran detached under the memory and disk guard; nothing else ran on the host (lowest MemAvailable 7,007 MB, disk 59 %). Raw: `bench/results/raw/2026-11-01-B13.json` (and `.hw.json`), with every render time and client time.
