# B16 — Dev loop, template edit on examples/shop (#43) — 2026-10-28
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, 16 GB RAM, Linux 6.18.44-fc-v180), git 42143f1, rustc 1.99.1, bun 1.4.4, node 22.22.0, deno n/a
Scenario: Edit one template, browser updated. `renox dev` on a fresh copy of examples/shop (debug `renox-worker`), 20 edits of `pages/products/index.html` per run (a new `<li>` inside the `product_list` fragment). Each sample is the time from the file write to the moment the browser has the new HTML: the `templates` event on `/__renox/dev/events` (watcher, 30 ms debounce, `renox-worker transpile`, bundle cache hit, artifact write, route switch, SIGHUP), then the fragment request the dev client makes (`HX-Target: product-list`, fresh isolate for the new hash, loader, render). The DOM swap itself is not timed
Result: update_ms 105.8 ms (p50), p99 150.5 ms, n = 60
Target: ≤ 300 ms (fail: > 1 s) → PASS
Notes: profile dev-laptop, runs 3; not node-small: relative comparison only, never pass/fail; worker is a debug build; `bench/scenarios/B16/run.sh` (RENOX_WORKER_PATH required)
Raw: bench/results/raw/2026-10-28-B16.json

Verdict: **B16 met on the dev laptop.** A template edit reaches the browser in about 106 ms at p50 and 151 ms at p99, half the 300 ms target. F1's first data point (`cli/README.md`, function edit on `examples/hello`, 58-69 ms) did not compile templates and had no loader query.

Where the time goes (one edit, from the `renox dev` terminal): the 30 ms debounce, about 10 ms for the template compile (the worker subcommand, measured cold at p50 9.0 ms in `bench/scenarios/B16/transpile.ts`), a cached bundle, then the new hash's first request, which pays for a fresh isolate (D19) and the loader's five queries. The fragment swap happens in the browser after that.
