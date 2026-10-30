# B1 — Memory per warm isolate on `node-small` — 2026-10-30

Hardware: node-small (AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM (7,941 MB), SSD (QEMU virtual disk, non-rotational), Ubuntu 24.04.5, Linux 6.8.0-147-generic; a KVM VPS), git 7281224 (batch O3-HOST; no worker code changed since `main` 1664c60), renox-worker release (`deno_runtime` 0.268.0, prebuilt `rusty_v8` 150.4.0), rustc 1.99.1, bun 1.4.4
Scenario: renox-worker (release), N tenants per app, each with one warm isolate after one request (`shop`: `GET /api/products`; `hello`: `GET /api/hello`); N = 1, 10, 50, 100; esm-dir artifacts from the CLI; median of 3 runs per N; judged: `shop` at N = 100. No load generator is involved (one request per tenant, sequential), so this runs on `node-small` alone; B4, B11 and B12 wait for the load-generator host (#158).

| | N = 1 | N = 10 | N = 50 | N = 100 | V8 heap per isolate |
| --- | --- | --- | --- | --- | --- |
| `shop` (judged) | 31.52 MB | 12.42 MB | 10.32 MB | **10.07 MB** | 4.16–4.17 MB |
| `hello` | 26.58 MB | 9.00 MB | 6.87 MB | 6.64 MB | 4.15 MB |

RSS delta per isolate, median of 3 runs (PSS within 0.06 MB of RSS at every point).

Target: ≤ 10 MB RSS delta (fail: > 20 MB) → **FAIL on target by 0.07 MB, inside the limit** (`shop`, 10.07 MB). `hello` 6.64 MB.

## Method and raw command lines

```
sudo apt-get install -y build-essential pkg-config clang lld cmake protobuf-compiler unzip curl docker.io docker-compose-v2
rustup (toolchain from rust-toolchain.toml, 1.99.1); bun 1.4.4 (bun.sh/install)
export RUSTY_V8_ARCHIVE=$(ops/v8-archive.sh fetch x86_64-unknown-linux-gnu ~/bench-tools/rusty_v8)   # verified against ops/v8-checksums.txt
CARGO_PROFILE_RELEASE_DEBUG=0 cargo build --release --locked -j 3 -p renox-cell --bin renox-worker  # 34 min, 2.4 GB peak RSS
RENOX_WORKER_PATH=$PWD/target/release/renox-worker bench/run.sh B1 --profile node-small --runs 3                 # attempt 1: shop complete, then hello failed at N = 10
RENOX_WORKER_PATH=... B1_APPS=hello bench/run.sh B1 --profile node-small --runs 3                                 # hello complete
RENOX_WORKER_PATH=... B1_APPS=shop bench/run.sh B1 --profile node-small --runs 3                                  # attempts 2 and 3 (the second with BENCH_KEEP=1): failed at N = 50
```

Every run after attempt 1 ran detached from the session under a guard that logged MemAvailable and disk every 5 s and would stop the run below 1 GB available or above 80 % disk; the lowest MemAvailable seen was 6,404 MB, disk 15 % used. Nothing else ran on the host during a run.

Raw: `bench/results/raw/2026-10-30-B1-hello.json` (and `.hw.json`). The `shop` medians above are the lines attempt 1 printed after the three runs of each N (`B1: shop N=…`); its raw JSON was not written, because the scenario exits on the later `hello` error before writing. Attempts 2 and 3 reproduced `shop` at N = 1 (33.30, 33.55 MB) and N = 10 (12.46, 12.39 MB) before failing.

## Findings

- **A spurious `RENOX_CPU_LIMIT` on a cold first request**, three times in four attempts (`hello` at N = 10 once, `shop` at N = 50 twice), each time on the first request to a fresh tenant, one request at a time on a quiet host. In the kept run (`BENCH_KEEP=1`), 44 cold first requests to `shop` were charged 10.6 ms CPU at the median and 16.3 ms at p90; one was charged 51.9 ms (wall 154 ms) and answered 503 at the free tier's 50 ms limit (request `01M66ZKKH6KJGH235JJ1T7CQJ3`, tenant `t_shop_7`). The two requests before it were charged 14.2 and 13.0 ms. A tenant doing nothing wrong gets a 503: the same class as #155 (closed). Not seen in the F1 runs on the dev container. Follow-up: #342.
- **`shop` costs more per isolate here than on the dev container**: 10.07 MB against 7.33 MB in [the lazy-routes run](2026-10-29-B1-lazy-routes-renox-worker.md) (same scenario, kernel 6.18, 16 GB), while the V8 heap per isolate is the same (4.17 vs 4.25 MB). The difference is outside the V8 heap (allocator, kernel, page size or THP policy; THP is `madvise` here). Follow-up: #343.
- The V8 heap per isolate is flat from N = 1 to N = 100 (4.15–4.17 MB), so the per-isolate RSS falls with N only through the worker's fixed cost being shared.
