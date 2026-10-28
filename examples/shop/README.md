# examples/shop

A small shop as Renox functions (F1) and pages (F2, #45). The realistic "tenant B" workload of the benchmarks and the app the F1 gate's B1 condition is judged on (`docs/14-benchmarks.md`).

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /api/products` | The first 100 products by id. `?q=` searches name and description (case-insensitive, `%` and `_` are literal), `?category=dates\|coffee\|spices\|sweets\|perfume` filters |
| `GET /api/products/:id` | One product; 404 when missing, 400 when `id` is not a positive integer |
| `POST /api/cart` | `{"cart_id": "c_1", "product_id": 7, "quantity": 2}`, validated with zod (strict: unknown keys refused). Stock is checked and the item inserted in one transaction; 201 with the cart's item count and total, 404 for an unknown product, 409 when the cart would exceed the stock |
| `POST /api/checkout` | `{"cart_id": "c_1"}`: builds the Stripe PaymentIntent request for the cart's total (AED, amounts in fils) with the official `stripe` SDK. No network call: `renox.toml` declares no outbound host |
| `POST /api/dev/seed` | Loads `seeds/products.sql` (100 deterministic products), idempotent. Answers 404 unless the request came through `renox dev` (the host is `<app>.localhost`); a stand-in until `renox db seed` exists (F2+) |

Every statement is parameterised (`renox check` passes). Prices are integers in fils (1 AED = 100 fils).

## Pages

| Page | Files | What it does |
| --- | --- | --- |
| `/` | `pages/index.html` | Static home page (`.html` only, no loader) |
| `/products` | `pages/products/index.{ts,html}` | **B6 page**: 100 products as `partials/product-card.html` cards, category counts, price range, cart badge: exactly five queries, 20-30 KB of HTML. The search box sends `hx-get` with `HX-Target: product-list`: the cell renders only the `product_list` fragment, and the loader runs one query for at most 20 matches (**B7**) |
| `/products/:id` | `pages/products/[id].{ts,html}` | One product; 404 for an unknown or malformed id. `<x-form action="addToCart">` posts `?/addToCart`: the action checks stock and inserts into the session's cart (`cart_id` = `ctx.session.id`) in the action's transaction; an htmx post gets the `product` fragment back with the `cart_badge` fragment out of band, a plain post the full page |
| `_layouts/main`, `_404`, `_error` | `pages/_layouts/main.html`, `pages/_404.html`, `pages/_error.html` | Layout (header with the cart badge fragment), not-found and error pages |

`public/` holds `app.css` and `htmx-2.0.4.min.js` (htmx 2.0.4 from the npm package `htmx.org`, license 0BSD, vendored unchanged so the shop needs no outbound host). `htmx-config` turns off htmx's inline indicator styles, which the strict CSP would refuse.

**Browser check.** `RENOX_WORKER_PATH=../../target/debug/renox-worker bun tests/browser-check.ts` drives the four interactions in Chromium (Playwright, `PLAYWRIGHT_PATH` or a global install) under the strict CSP and fails on any console error, CSP violations included. `screenshots/` holds its output: `1-list.png` (100 cards), `2-search.png` (`saffron`: the `product_list` fragment swapped, URL pushed), `3-detail.png`, `4-add-to-cart.png` (the `product` fragment with "Added 2 to your cart." and the badge at 2 out of band).

Building the shop compiles its templates with `renox-worker transpile` (`cli/README.md`, "Templates"), so `renox build`/`renox check`/`renox dev` need the worker binary.

## Data

`migrations/001_init.sql`: `app__products` (id, name, description, price_fils, stock, category, image path) and `app__cart_items` (cart_id, product_id → products, quantity 1–99, created_at), with indexes on category, name, and cart. `seeds/products.sql` is generated: 100 products, 20 per category, four sizes each.

## Run

```
cargo build -p renox-cell --bin renox-worker            # or bun cli/scripts/fetch-worker.ts <version>
cd examples/shop
RENOX_WORKER_PATH=../../target/debug/renox-worker bun ../../cli/src/main.ts dev --port 8787
curl -X POST localhost:8787/api/dev/seed                # {"products":100}
curl 'localhost:8787/api/products?q=saffron'
curl -X POST localhost:8787/api/cart -H 'content-type: application/json' -d '{"cart_id":"c_1","product_id":42,"quantity":3}'
curl -X POST localhost:8787/api/checkout -H 'content-type: application/json' -d '{"cart_id":"c_1"}'
```

`bun test` runs the functions against a fake `ctx` (bun:sqlite with the real migration and seed) and `renox build` + `renox check`; with `RENOX_WORKER_PATH` set it also runs every flow above through `renox dev` and the worker (`tests/shop.e2e.test.ts`).

## Used by

| Benchmark | Use |
| --- | --- |
| B1 | Memory per isolate with a realistic dependency set: zod and the Stripe SDK (F1 gate condition, #37: ≤ 20 MB as eszip) |
| B6 | `GET /products`: 100 items, five queries (`tests/pages.test.ts` counts them; `tests/shop.e2e.test.ts` checks 20-30 KB and 108 rows read in the meter) |
| B7 | The `product_list` fragment of `GET /products?q=` with `HX-Target: product-list`: one query, at most 20 items |
| B8, B9 | Data-path and render benchmarks on the same tables (F2) |
| B12 | Tenant B's workload while tenant A runs `examples/evil` |
| B16 | Dev-loop timing on a real app: `bench/scenarios/B16/run.sh` edits `pages/products/index.html` |

## Notes

- Tables are `app__*`, not `shop__*`: in F1 the app's own code runs as module `app` and its authorizer allows only `app__*` (`crates/renox-data` README, "Reserved module names").
- The bundled modules are large because every module vendors its own dependencies and carries an inline source map (`checkout.js` ≈ 3.2 MB with Stripe, `cart.js` ≈ 0.9 MB with zod); B1 measures what that costs per isolate.
