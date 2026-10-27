# examples/shop

A small shop as Renox functions (F1: functions only; pages and partials come in F2, #45). The realistic "tenant B" workload of the benchmarks and the app the F1 gate's B1 condition is judged on (`docs/14-benchmarks.md`).

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /api/products` | The first 100 products by id. `?q=` searches name and description (case-insensitive, `%` and `_` are literal), `?category=dates\|coffee\|spices\|sweets\|perfume` filters |
| `GET /api/products/:id` | One product; 404 when missing, 400 when `id` is not a positive integer |
| `POST /api/cart` | `{"cart_id": "c_1", "product_id": 7, "quantity": 2}`, validated with zod (strict: unknown keys refused). Stock is checked and the item inserted in one transaction; 201 with the cart's item count and total, 404 for an unknown product, 409 when the cart would exceed the stock |
| `POST /api/checkout` | `{"cart_id": "c_1"}`: builds the Stripe PaymentIntent request for the cart's total (AED, amounts in fils) with the official `stripe` SDK. No network call: `renox.toml` declares no outbound host |
| `POST /api/dev/seed` | Loads `seeds/products.sql` (100 deterministic products), idempotent. Answers 404 unless the request came through `renox dev` (the host is `<app>.localhost`); a stand-in until `renox db seed` exists (F2+) |

Every statement is parameterised (`renox check` passes). Prices are integers in fils (1 AED = 100 fils).

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
| B6 | `GET /api/products` as the page-render proxy until pages exist (F2) |
| B7, B8, B9 | Data-path and render benchmarks on the same tables (F2) |
| B12 | Tenant B's workload while tenant A runs `examples/evil` |
| B16 | Dev-loop timing on a real app |

## Notes

- Tables are `app__*`, not `shop__*`: in F1 the app's own code runs as module `app` and its authorizer allows only `app__*` (`crates/renox-data` README, "Reserved module names").
- The bundled modules are large because every module vendors its own dependencies and carries an inline source map (`checkout.js` ≈ 3.2 MB with Stripe, `cart.js` ≈ 0.9 MB with zod); B1 measures what that costs per isolate.
