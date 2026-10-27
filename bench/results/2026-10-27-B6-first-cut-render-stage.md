# B6 — SSR medium page, first cut (render stage only) — 2026-10-27
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.80GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v165), git 4ca9ae6, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: B6 first cut (render stage only): shop-products.html via template-proto + minijinja 3.0.4, products already minijinja::Value; criterion median, median of runs (bench/spike/render-bench)
Result: page_100_us 176, fragment_100_us 169, fragment_captured_100_us 343.9, page_1000_us 1765, page_fuel_100_us 179.6, fuel_overhead_pct 2.01, page_100_kb 24.72, fragment_100_kb 23.48, page_1000_kb 238.3, page_100_fuel 4780, marshal_us 248.3, render_plus_marshal_us 424.3
Target: full B6 (p50 ≤ 3 ms, p99 ≤ 15 ms end to end) not judged, first cut; derived check render + marshal ≤ 1 ms p50 → PROVISIONAL PASS (424.3 µs)
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; criterion 3 s warm-up + 5 s measurement; marshal_us is the best B9 path from bench/results/raw/2026-10-27-B9.json (extra path `json_string_struct`); with the best of the four paths issue #10 names (`struct`, 397.7 µs) the total is 573.7 µs, still a PASS
Raw: bench/results/raw/2026-10-27-B6.json

## Render stage

| Measurement | p50 (µs) | Output |
| --- | --- | --- |
| (a) Full page, 100 products | 176.0 | 24.7 KB (25,311 bytes), within 20–30 KB |
| (b) Fragment `product_list`, compiled as its own template, 100 products | 169.0 | 23.5 KB |
| (b') Fragment via `render_captured_to(sink)` + `State::render_block` | 343.9 | same bytes as (b) |
| (c) Full page, 1,000 products | 1,765 | 238 KB |
| Full page with fuel tracking on (`minijinja` `fuel` feature, budget 2^40) | 179.6 | identical output; 4,780 fuel consumed |

- Rendering scales linearly: 1,000 items take 10.0× as long as 100. That is about 1.7 µs per product card of about 240 bytes.
- **Fuel overhead is about 2%**, which is within run-to-run noise (one run had fuel faster than without). The F2 render DoS limit is effectively free. A 100-unit budget stops this page with `OutOfFuel` (`tests/output.rs`). This page consumes 4,780 units, which gives a scale for choosing the F2 default budget.
- **Fragment serving needs its own compiled template.** minijinja 3 has no way to render one block without evaluating the page first (`eval_to_state` is gone). Going through the captured state costs the whole page plus the block (343.9 µs, 2×). Compiling each `r-fragment` block as a separate template at deploy time costs only the fragment. Here the fragment is almost the whole page, so 169 µs vs 176 µs. The two outputs are byte-identical (`tests/output.rs`). F2 (`crates/renox-template`) should emit one compiled template per fragment.

## Against the estimates in `docs/08-template-engine.md`

| Stage | Estimate | Measured |
| --- | --- | --- |
| Instruction execution + escaping and buffer writes | ~35–140 µs together | 176 µs for the whole render (a), not split |
| Marshaling V8 → Rust (`serde_v8`) | ~50–300 µs | 397.7 µs via `serde_v8` (best of the four issue #10 paths); 248.3 µs via `JSON.stringify` + typed parse (B9) |

Both stages are above the estimate. Rendering is about 25% above its upper bound. Marshaling via `serde_v8` is above its upper bound, and only the `JSON.stringify` path is within the range. Enabling minijinja's `speedups` feature (SIMD-capable escaping) moved (a) from 176 to 166 µs in one probe run, which is within noise; the escaping is not the bottleneck.

## Prediction for the full B6 path

Render plus marshal is 424 µs at p50, against the 1 ms budget that leaves room for the rest of the request (HTTP, five SQLite queries at B10's target ≤ 20 µs each, the loader in the isolate). So the render stage is not what would make B6 miss p50 ≤ 3 ms. The open risks for B6 are outside the render stage: the isolate hop and the loader's own work. These are measured when B6 runs end to end in F2.
