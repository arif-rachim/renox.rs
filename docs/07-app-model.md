# 07 — Tenant application model

URL and behavior are determined by file location and name (convention over configuration). Configuration is only an escape hatch.

## Project structure

```
my-app/
├── renox.toml              app config + module list
├── public/                 static files, served by the gateway outside the tenant quota
├── pages/                  SSR
│   ├── _layouts/main.html  layouts (files starting with _ are not routes)
│   ├── _404.html
│   ├── index.html          /
│   └── products/
│       ├── index.html      /products
│       ├── index.ts
│       ├── [id].html       /products/:id
│       └── [id].ts
├── partials/               template components (<x-name>)
├── functions/              APIs: functions/api/checkout.ts -> /api/checkout
│   ├── ws/                 WebSocket handlers: functions/ws/chat/[room].ts -> /ws/chat/:room
│   ├── webhooks/           inbound webhooks (CSRF-exempt, signature-verified)
│   └── tools/              MCP tools exposed at /mcp (see 20-ai-agents-mcp.md)
├── migrations/             SQL owned by the app (tables prefixed app__)
├── policies/               Cedar policies owned by the app
├── jobs/                   scheduled jobs: jobs/nightly-report.ts with export const schedule
└── overrides/<module>/     override module templates without forking
```

## Routing rules

| Pattern | Example file | URL |
| --- | --- | --- |
| Static | `pages/about.html` | `/about` |
| Folder index | `pages/products/index.html` | `/products` |
| Parameter | `pages/products/[id].html` | `/products/42` → `params.id = "42"` |
| Catch-all | `pages/docs/[...slug].html` | `/docs/a/b` → `params.slug = ["a","b"]` |
| Not a route | `pages/_layouts/*`, `_404.html` | not directly reachable |
| API | `functions/api/orders.ts` exporting `GET`/`POST`/... | `/api/orders` |
| WebSocket | `functions/ws/chat/[room].ts` exporting `ws` | `/ws/chat/:room` |
| SSE | `functions/sse/orders.ts` exporting `sse` | `/sse/orders` |

Priority on conflict: static → parameter → catch-all. Ambiguous conflicts (two modules mounting the same path) are rejected at deploy time, not at request time.

## Pages: `.ts` and `.html` pairs are optional

| Files present | Behavior |
| --- | --- |
| `.html` only | Template rendered without loader data |
| `.ts` only | `load()` must return a `Response` (redirect, JSON, custom HTML) |
| `.ts` + `.html` | `load()` returns an object → template data |

The same rule applies inside `load()`: returning a `Response` skips the template; returning an object makes it template data.

```ts
// pages/products/[id].ts
import type { LoaderContext, ActionContext } from "renox";

export const guard = { action: "product.read" };

export async function load({ params, db, url }: LoaderContext) {
  const product = await db.queryOne("select * from shop__products where id = ?", [params.id]);
  if (!product) return new Response(null, { status: 404 });
  return { product, inStock: product.stock > 0 };
}

export const actions = {
  async addToCart({ form, db, session, authz }: ActionContext) {
    const productId = form.get("productId");
    await authz.require("cart.add", { id: productId });
    await db.execute("insert into shop__cart_items (session_id, product_id) values (?, ?)", [session.id, productId]);
    return { fragments: ["cart_badge", `product_${productId}`] };   // extra fragments rendered out-of-band
  },
};
```

Actions are invoked with `POST ?/addToCart`. They receive validated form data, run inside a transaction by default, and may return an object (template data for fragments), a `Response`, or `{ fragments: [...] }`.

**Why two files instead of a single-file component:** editors provide TypeScript highlighting and type checking without plugins, and the transpiler stays simple. A single-file format (`<script server>`) can be added later as sugar that is split at deploy time.

## Functions

```ts
// functions/api/orders.ts
import type { Handler } from "renox";

export const GET: Handler = async ({ db, auth, url }) => {
  const user = await auth.requireUser();
  const orders = await db.scoped({ user_id: user.id }).query("select * from shop__orders order by created_at desc limit 50");
  return Response.json(orders);
};

export const POST: Handler = async ({ req, db, auth, validate }) => {
  const body = await validate(req, OrderSchema);   // schema validation before the handler body
  // ...
  return Response.json(order, { status: 201 });
};
```

## Inbound webhooks

Webhooks from payment gateways (Stripe, Checkout.com, Telr, PayTabs, Network International), Apple App Store Server Notifications, Google Play RTDN, and similar providers are ordinary functions with platform helpers for verification, deduplication, and deferred processing.

```ts
// functions/webhooks/telr.ts  ->  POST https://<app>/webhooks/telr
export const POST = async ({ req, webhook, events }) => {
  const payload = await webhook.verify(req, { provider: "telr" });    // signature + replay check
  await events.emit("billing.payment_received", payload, { durable: true });
  return new Response("ok");                                             // respond fast; work happens later
};
```

| Concern | Platform behavior |
| --- | --- |
| Authenticity | `webhook.verify()` checks the provider's signature scheme (HMAC for Stripe, Checkout.com, Telr, PayTabs, N-Genius, JWS for Apple, Pub/Sub JWT for Google, or a generic HMAC/`secret` header for custom senders). Keys come from secrets. Failure returns 401 before user code runs |
| Replay / duplicates | Each verified event id is stored in `renox__webhook_events (provider, event_id, received_at)`; duplicates return 200 without re-emitting |
| Slow processing | Handlers should only verify and emit a durable event; the outbox worker does the real work with retries and dead-lettering (`10-modules.md`) |
| Direction and network rules | Inbound webhooks are not subject to the egress allowlist. Callbacks the app makes to the provider (receipt verification, status checks) need the host in `[permissions] network` |
| CSRF | Webhook routes under `functions/webhooks/` are exempt from CSRF tokens; they rely on signature verification instead |
| Rate limiting | Per-provider limits with a generous burst; verified events are never dropped by the limiter, unverified ones are |
| Local testing | `renox dev --tunnel` exposes a temporary public URL; `renox webhook replay <id>` re-delivers a stored event |

The `billing` module ships verified webhook handlers for Stripe, Checkout.com, Telr, PayTabs, N-Genius, and Tabby/Tamara, and adds Apple and Google subscription notifications in a later version (`18-build-plan.md`, M4).

## Scheduled jobs

```ts
// jobs/nightly-report.ts
export const schedule = "0 2 * * *";          // minute hour day-of-month month day-of-week
export const tz = "Asia/Dubai";                // optional IANA zone; UTC when absent
export async function run(ctx) {               // a named export (ops.md section 20)
  const { db, events, log, job } = ctx;        // job: { id, name, tick, attempt, payload }
  /* ... */
}
```

Jobs run as the principal `System::"app"` (a module's as `System::"<module>"`) with explicit permissions and are charged to the tenant quota. Each tick is one durable outbox row, run at least once and never twice at the same time; ticks missed while the tenant had no cell (an eviction, a restart, downtime) become one run for the latest of them. `ctx.jobs.enqueue(name, payload, { runAt })` queues a run of one of the caller's own jobs inside the current transaction. The `jobs` module shows the scheduled, queued, running and failed runs and retries or cancels them; `renox jobs` does the same for `renox dev`, which runs the scheduler only with `--jobs`.

## The `ctx` surface (SDK)

| Field | Available in | Purpose |
| --- | --- | --- |
| `req`, `url`, `params`, `headers` | all handlers | Request data |
| `form` | actions | Parsed and CSRF-checked form data |
| `db` | all | SQLite bound to the tenant and the module's authorizer; `db.scoped()`, `db.transaction()`; optional Kysely/Drizzle drivers on top |
| `datasource(name)` | all | Handle to an external Postgres/MySQL declared in `renox.toml`, pooled in Rust (see `06-data.md`) |
| `kv` | all | Ephemeral in-memory cache per cell (not persisted) |
| `ai` | all | `chat()`, `embed()` against allowlisted providers or the platform AI gateway; metered (see `20-ai-agents-mcp.md`) |
| `webhook` | webhooks | `verify(req, { provider })`: signature check and replay protection |
| `domains` | all | `add()`, `status()`, `remove()` for domains owned by the app's own customers (see `05-tenant-lifecycle.md`) |
| `auth` | all | `requireUser()`, `currentUser()`, session helpers (from the auth module) |
| `authz` | all | `require(action, resource)`, `can()`, `canBatch()` |
| `session` | all | Server session (cookie-backed) |
| `events` | all | `emit(name, payload, { durable })` |
| `hooks` | services | `run(name, payload)` for modules that expose hook points |
| `realtime` | all | `publish(topic, payload)`, `subscribe(conn, topic)` |
| `secrets` | all | Frozen object of declared secrets |
| `config` | all | Module config from `renox.toml` |
| `render` | all | Render a partial to a string (for realtime payloads or email) |
| `fetch` | all | Allowlisted outbound HTTP |
| `log` | all | Structured logging (tenant-visible) |
| `deadline` | all | Remaining time budget |
| `offload` | all | Run CPU-heavy work in a separate pool with its own quota |

Types for `ctx`, `params`, services, events, and action names are generated into `.renox/types/` by `renox dev` (`12-developer-experience.md`).

## Configuration escape hatch

```toml
# renox.toml
[app]
name = "shop"
timezone = "Asia/Dubai"

[[routes]]
path = "/p/:id"
page = "products/[id]"     # legacy URL alias

[modules]
auth    = { version = "^1.0" }
billing = { version = "^1.2", mount = "/billing", config = { provider = "telr" } }
```

## State rules

Module contexts are reused across requests, so JavaScript globals are shared between users. Per-request data must go through `ctx`; globals are allowed only for intentionally shared caches. `renox dev` warns when a handler writes to global scope.
