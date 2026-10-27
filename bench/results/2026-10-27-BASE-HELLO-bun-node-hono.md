# BASE-HELLO — Bun + Hono and Node + Hono hello baseline — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v153), git 8fc39d3, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: bench/baselines/hello-hono (hono 4.13.14, @hono/node-server 2.1.5), GET / -> {"ok":true}; startup 50 samples (spawn -> first 200); oha 1.16.0 -c 64, 30 s warm-up + 60 s, 3 runs, median of runs
Result: bun_rss_idle_mb 23.1, bun_rss_load_mb 31.9, bun_startup_p50_ms 18.3, bun_startup_p99_ms 39.8, bun_p50_ms 0.982, bun_p99_ms 3.155, bun_req_per_s 53774, node_rss_idle_mb 79, node_rss_load_mb 111, node_startup_p50_ms 134, node_startup_p99_ms 168.8, node_p50_ms 2.609, node_p99_ms 5.224, node_req_per_s 23483
Target: none → INFO
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; informational baseline (docs/14-benchmarks.md, "Baselines to compare against"); load generator on the same 4 vCPUs as the server, so latency includes oha's own CPU use and throughput is a lower bound
Raw: bench/results/raw/2026-10-27-BASE-HELLO.json

## Comparison

| Metric | Bun + Hono | Node + Hono | Edge Runtime (Renox path) | Compare with |
| --- | --- | --- | --- | --- |
| RSS idle after first request | 23.1 MB per process | 79.0 MB per process | no result yet | B1 (≤ 10 MB per warm isolate) |
| RSS under load | 31.9 MB | 111 MB | no result yet | — |
| Start to first response | p50 18.3 ms, p99 39.8 ms (process spawn) | p50 134 ms, p99 168.8 ms (process spawn) | no result yet | B4 (p50 ≤ 20 ms, p99 ≤ 100 ms, isolate from snapshot) |
| Warm latency, 64 connections | p50 0.98 ms, p99 3.16 ms | p50 2.61 ms, p99 5.22 ms | no result yet | B5 (in-node, no network: p50 ≤ 0.3 ms) |
| Throughput | 53,774 req/s | 23,483 req/s | no result yet | B11 (≥ 40k req/s) |

No B1, B4, or B5 result files exist yet (`bench/results/`): those come from the Edge Runtime spike (#3, #6, #7) in batch B. When they land, fill the Edge Runtime column from their result files; until then this table is the reference envelope.

Reading notes:
- These are per-process numbers. The baseline's density model is one process per app, so the RSS column is also the per-tenant memory cost. That is the number the isolate model has to beat by keeping a warm isolate near B1's 10 MB.
- The B5 latency is measured in-node without HTTP, so it is not directly comparable to these over-HTTP numbers. B11 is the over-HTTP comparison.
- Raw per-run samples (latency, req/s, RSS once a second during load, 50 startup samples per runtime) are in the raw file.
