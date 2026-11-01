# B9 — Marshaling cost on `node-small` — 2026-11-01

Hardware: node-small (AMD EPYC Processor (with IBPB), 4 vCPU, 8 GB RAM, SSD, Ubuntu 24.04.5, Linux 6.8.0-147-generic; a KVM VPS), git 46fdfce (`main`), rustc 1.99.1, bun 1.4.4
Scenario: criterion benchmark `bench/spike/marshal-bench` (V8 → `minijinja::Value`), 10 fields per item at 10 / 100 / 1,000 items, every path; 3 runs (each its own criterion baseline, warm-up 3 s, measurement 5 s), median of runs. No worker, no network.

| Path, µs (median of 3 runs) | 10 items | **100 items** | 1,000 items |
| --- | --- | --- | --- |
| `json_string` (generic: `JSON.stringify` → `serde_json::Value` → `minijinja::Value`; what the render op does) | 60.6 | **645.3** | 7,283 |
| `json_string_struct` (JSON string into a static Rust type) | 29.1 | 290.4 | 3,112 |
| `struct` (`serde_v8` into a static Rust type) | 45.7 | 497.1 | 5,152 |
| `walker` (V8 API, property by property) | 72.0 | 713.1 | 8,236 |
| `serde_json` (`serde_v8` → `serde_json::Value`) | 102.4 | 1,016 | 12,020 |

Target: ≤ 300 µs at 100 items (fail: > 1 ms). `bench/run.sh` judges the best path (`json_string_struct`, 290.4 µs → PASS), but loader data has no static Rust type, so the path that counts is the generic one: **645.3 µs → FAIL on target, inside the limit**, as on 2026-10-27 ([dev-laptop: 517 µs generic, 248 µs struct](2026-10-27-B9-marshal-v8-minijinja.md)). This host is 25 % slower on the generic path and 17 % slower on the static path than the dev laptop.

## Raw command lines

```
export RUSTY_V8_ARCHIVE=$(ops/v8-archive.sh fetch x86_64-unknown-linux-gnu ~/bench-tools/rusty_v8)
bench/run.sh B9 --profile node-small --runs 3
```

Ran detached under the memory and disk guard after the B13, B2 and chaos runs; nothing else ran on the host (lowest MemAvailable 6.4 GB, disk 59–60 %). Raw: `bench/results/raw/2026-11-01-B9.json` (and `.hw.json`).
