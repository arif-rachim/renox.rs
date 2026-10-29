# B6 — the shop list page with `auth` installed (#241) — 2026-10-29

Hardware: the dev container (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU, Linux 6.18.44-fc-v185), rustc 1.99.1, bun 1.4.4. One **debug** `renox-worker` (`cargo build -p renox-cell --bin renox-worker`, `CARGO_PROFILE_DEV_DEBUG=0`) for both variants: the release build of `bench/run.sh B8` did not fit the session's disk allowance. So the absolute numbers are not B6's (which wait for `node-small`, #158), but the before/after comparison on one binary is valid.

Variants: **before** is `examples/shop` at the commit before #241 (no modules). **After** is this branch: `auth` installed, the `app.header` slot in the layout, and `auth.currentUser()` in the list page's loader.

Method: `cli/src/lib/test-harness.ts` (#238) starts the worker on a fresh tenant file, then `POST /api/dev/seed` (100 products). After 100 warm-up requests, 500 sequential `GET /products` are timed in the client, to the last byte. `cpu_ms` and `db_rows` come from the meter records. Two runs, alternating before and after (raw: `raw/2026-10-29-B6-shop-with-auth.json`).

| Run | Before p50 / p99 ms | After p50 / p99 ms | p50 change | Before / after `cpu_ms` p50 | Before / after `db_rows` |
| --- | --- | --- | --- | --- | --- |
| 1 | 8.25 / 20.76 | 8.69 / 13.09 | 5.30 % | 1.363 / 1.482 | 108 / 108 |
| 2 | 8.06 / 12.99 | 9.25 / 27.10 | 14.74 % | 1.324 / 1.535 | 108 / 108 |

Result: **finding (not a blocker; > 5 % p50, as #241 defines it).** With `auth`, the page costs about 5–15 % more p50 and 9–16 % more `cpu_ms` on the debug build. The rows read are unchanged (108): an anonymous request returns from `currentUser` before any query, because it has no `__Host-renox_auth` cookie.

What the page pays for now, per request:
- the broker's service call (`renox:modules` proxy, the callee's ctx, the async-context switch);
- the slot partial in the layout;
- a second module in the isolate.

To confirm on the release build and `node-small` (#158). If it holds there, the candidates are:
- a cheaper proxy path in the broker (the callee's ctx is already built once per module per request);
- skipping the service call when the request has no cookie at all (the app can check `ctx.headers` before calling).
