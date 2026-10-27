# B9 — Marshaling cost — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 000dcbd, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: 100 items × 10 fields V8 → minijinja::Value; criterion median per path at 10/100/1000 items, median of runs (bench/spike/marshal-bench, v8 130.0.7 prebuilt, serde_v8 0.233.0, minijinja 3.0.4, serde_json 1 with float_roundtrip)
Result: marshal_us 248.3 µs, json_string_10_us 48.63, json_string_100_us 517.1, json_string_1000_us 5812, json_string_struct_10_us 23.95, json_string_struct_100_us 248.3, json_string_struct_1000_us 2775, serde_json_10_us 78.96, serde_json_100_us 795.3, serde_json_1000_us 8529, struct_10_us 38.44, struct_100_us 397.7, struct_1000_us 4173, walker_10_us 54.79, walker_100_us 564.2, walker_1000_us 5986
Target: ≤ 300 µs (fail: > 1 ms) → PROVISIONAL PASS on the best path (an extra fifth path); the best of the four paths the issue names misses the target (397.7 µs) but stays under the fail threshold
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; criterion 3 s warm-up + 5 s measurement per path and size; each iteration opens its own handle scope
Raw: bench/results/raw/2026-10-27-B9.json

## Results at 100 items (median of 3 runs)

| Path | What it does | µs | vs target 300 µs |
| --- | --- | --- | --- |
| 1 `serde_json` | `serde_v8::from_v8::<serde_json::Value>` → `Value::from(Serde(..))` | 795.3 | miss |
| 2 `struct` | `serde_v8::from_v8::<Vec<Product>>` → `Value::from(Serde(..))` | 397.7 | miss |
| 3 `walker` | hand-written `v8::Local<Value>` → `minijinja::Value`, no serde | 564.2 | miss |
| 4 `json_string` | `JSON.stringify` in V8 → `serde_json::from_str::<Value>` → `Value::from(Serde(..))` | 517.1 | miss |
| extra `json_string_struct` | `JSON.stringify` in V8 → `serde_json::from_str::<Vec<Product>>` → `Value::from(Serde(..))` | **248.3** | meets |

Scaling is linear in items for every path: about 2.5 µs per item for the best path and 4 µs per item for path 2. The 10, 100 and 1,000 numbers are in the Result line. Run-to-run spread is under 4% (raw file).

All five paths produce equal `minijinja::Value`s that render identically. `cargo test -p marshal-bench`, `tests/equality.rs`, checks this at 0, 1, 10 and 100 items.

## Where the time goes (one-off breakdown, 100 items, same machine)

A throwaway probe split the paths into stages. It is not committed; the numbers are indicative only.

| Stage | µs |
| --- | --- |
| Walking the object graph through the V8 API alone (`get_own_property_names` + `get` per property, no conversion) | 260–320 |
| …plus copying every string out of V8 (`to_rust_string_lossy`) | ~480 |
| `JSON.stringify` inside V8 + copying the 23 KB string out | ~102 |
| `serde_json::from_str` into `serde_json::Value` | ~274 |
| `serde_json::Value` → `minijinja::Value` | ~179 |
| `serde_json::from_str` into `Vec<Product>` → `minijinja::Value` | ~156 |
| `Vec<Product>` → `minijinja::Value` alone | ~52 |

The cost is in per-property V8 API calls, not in building `minijinja::Value`s: each call is about 200 ns, and 100 items × 11 properties plus nested objects is about 1,300 calls. `JSON.stringify` does the whole traversal in one call inside V8. After that, parsing JSON into a typed struct is the cheapest Rust side.

## Which path for F2

Use `JSON.stringify` in V8, then `serde_json::from_str` into a typed struct or a borrowed representation, then `minijinja::Value`. This is the extra path, and the only one that meets the target here.

- `docs/08-template-engine.md` expects that going straight to `minijinja::Value` without a JSON intermediate is fastest. This measurement says the opposite for V8: crossing the V8 API per property costs more than serialising once inside V8.
- Loader data has no static Rust type in Renox, because tenants write it in TypeScript. So the F2 version of the extra path must parse into something generic but cheap. A `serde_json::value::RawValue` or a `minijinja::Value`-producing `serde::Deserializer` visitor would avoid the `serde_json::Value` tree, the 274 + 179 µs of path 4. That is the experiment for #40.
- Path 2 (`serde_v8` into a struct) is the best of the four the issue names, at 397.7 µs. It needs a static type, which loader data does not have.
- A V8 `ValueSerializer` (structured clone) path was not measured and is worth one more data point in #40.

## Findings to carry forward

- `serde_json` without `float_roundtrip` misparses some doubles: `3.85` comes back as `3.8499999999999996`. Path 4 then no longer equals the others, and the equality test caught it. Any JSON path in F2 must enable `float_roundtrip`.
- Integral floats (for example `26.0`) arrive from V8 as integers on every path, because V8 stores them as Smis. They then print as `26`, not `26.0`. Templates that format prices must use a filter (`money`), not raw interpolation. The benchmark data uses non-integral floats so that all paths compare equal.
- The build uses the prebuilt V8 static library (`static lib URL: https://github.com/denoland/rusty_v8/releases/download/v130.0.7/librusty_v8_release_x86_64-unknown-linux-gnu.a.gz` in the `v8` build script output); nothing was built from source. The first `cargo build -p marshal-bench`, including the V8 download, took 58 s on this machine.
- The `v8` crate is crates.io 130.0.7, the version the pinned Edge Runtime (v1.77.8) uses. Supabase's runtime uses its patched fork `v130.0.7-patch.1`, so this number is for the same V8, not for the identical binary.
