# B6 — the shop with product images through `storage` (#332) — 2026-10-31

Hardware: the dev container (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, 8 vCPU, Linux 7.0.0-38-generic), rustc 1.99.1, bun 1.4.4. One **debug** `renox-worker` for both variants, as in [the shop with `auth`](2026-10-29-B6-shop-with-auth.md): the absolute numbers are not B6's (they wait for `node-small`, #158), but the before/after comparison on one binary is valid.

Variants: **before** is `examples/shop` at `d07c62f`. **After** is the #332 change:
- `migrations/005_product_images.sql`;
- the dev seed storing one PNG per category through `storage.upload`;
- `image` holding the stored key;
- `<x-image>` on the detail page.

The list page (B6) keeps its text cards: an `<x-image>` per card would add about 22 KB of `<img>` markup to a 25 KB page and change B6's workload ("25 KB, 100 items, 5 queries").

Method: `renox/test`'s harness starts the worker on a fresh tenant file, then `POST /api/dev/seed`. After 100 warm-up requests, it times 500 sequential `GET /products` and 300 `GET /products/42` in the client, to the last byte. `cpu_ms`, `render_fuel` and `db_rows` come from the meter records. Two runs per variant (raw: `raw/2026-10-31-B6-shop-product-images.json`).

| Run | List p50 / p99 ms | List `cpu_ms` p50 | List fuel / rows / bytes | Detail p50 / p99 ms | Detail `cpu_ms` p50 | Detail fuel / rows |
| --- | --- | --- | --- | --- | --- | --- |
| before 1 | 10.50 / 18.69 | 1.492 | 4434 / 108 / 25 616 | 4.56 / 7.32 | 0.786 | 174 / 2 |
| before 2 | 10.65 / 19.15 | 1.555 | 4434 / 108 / 25 616 | 4.62 / 6.14 | 0.778 | 174 / 2 |
| after 1 | 11.21 / 22.83 | 1.581 | 4434 / 108 / 25 616 | 4.84 / 6.12 | 0.843 | 192 / 2 |
| after 2 | 10.98 / 19.31 | 1.652 | 4434 / 108 / 25 616 | 4.81 / 10.66 | 0.792 | 192 / 2 |

Result: **B6 unchanged.** The list page has the same five queries, rows (108), render fuel (4434) and bytes (25 616). Its source did not change, so the 3–7 % p50 difference is run-to-run variance of the debug build on a shared container. The detail page's `<x-image>` adds 18 units of render fuel and no query: the image's key and dimensions are on the product row, so no storage call is made per render.
