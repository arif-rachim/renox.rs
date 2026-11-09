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
├── hooks.ts                handlers for module events (on) and fillers for module hook points (hooks)
└── overrides/<module>/     override module templates without forking
```

An app may have no code at all: `.html` pages and `public/` files only, with an empty `code.entry` in the artifact (artifact contract 1.6). It has no loaders, actions, functions, realtime or jobs until a `.ts` file exists.

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

## Static files (`public/`)

`public/<path>` is served at `/<path>` by the gateway, outside the tenant's isolate and quota, with an `ETag` from its content. A file whose name carries a content hash (`app.3f2a9c1b.js`) is sent `Cache-Control: public, max-age=31536000, immutable`; any other name is sent `max-age=0, must-revalidate`, so a browser asks again on every visit.

You do not hash names by hand: when a template links a public file with a literal `href` or `src` (`<link rel="stylesheet" href="/site.css">`, `<script src="/app.js">`), `renox build` adds a copy named after its content (`/site.3f2a9c1b5d6e7f80.css`) and points the template at it (#406). The browser, and Cloudflare in front of the platform, keep it until a deploy changes the file, and with it the name. The plain name stays available for anything else that uses it. A bound `:href`, a value with `{{ }}`, or a URL with a query is not rewritten.

Compression of `public/` files happens at Cloudflare's edge, not in the worker, which sends them as stored.

## Pages: `.ts` and `.html` pairs are optional

| Files present | Behavior |
| --- | --- |
| `.html` only | Template rendered without loader data |
| `.ts` only | `load()` must return a `Response` (redirect, JSON, custom HTML) |
| `.ts` + `.html` | `load()` returns an object → template data |

The same rule applies inside `load()`: returning a `Response` skips the template; returning an object makes it template data.

```ts
// pages/products/[id].ts
import type { LoaderContext, ActionContext } from "@renoxium/sdk";

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
import type { Handler } from "@renoxium/sdk";

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

## Events and hooks

The app handles events of its installed modules, and its own, and fills their hook points, from one file at the project root, `hooks.ts`. It has the same two exports as a module's `hooks.ts` (`10-modules.md`): `on` for event handlers and `hooks` for hook fillers.

```ts
// hooks.ts
export const on = {
  "billing.invoice_paid": async (ctx, e) => {            // e: { id, name, payload, attempt }
    await ctx.db.execute(
      "insert or ignore into app__receipts (event_id, invoice_id) values (?, ?)",
      [e.id, e.payload.invoice_id],                       // idempotent on e.id
    );
  },
};

export const hooks = {
  "auth.after_login": { priority: 50, async handle(ctx, { user }) {
    if (!user.accepted_terms) return { halt: true, response: Response.redirect(new URL("/terms", ctx.url), 303) };
  }},
};
```

A durable event reaches the app's handler exactly as it reaches a module's: one delivery per (event, handler) after the emitting transaction commits, with its own retries, then the dead letter; at least once, so a handler is idempotent on `e.id`. An in-memory event (`{ durable: false }`) runs the handlers before `emit` resolves, the app's last. The details are in `docs/contracts/ops.md` section 15.4 (1.12.0). A hook filler has the module shape `{ priority?, handle(ctx, args) }` and the module order: ascending `priority` (default 100), ties by module name, the app last on a tie. The app needs no `permissions.hooks` and no approval: it is the tenant's own code. The app fills hook points; it does not expose any.

A handler runs with a fresh `ctx` of the app and no request: no user, no session, no `req`. Its principal is the system principal `Renox::System::"app"` (`11-authorization.md`), the one the app's jobs use. `ctx.db` is the attempt's own transaction and has `db.scoped()`, so a handler that acts on a user's behalf can still go through the policies.

`renox check` warns when `hooks.ts` handles an event of a module that is not installed (the handler would never run; `app.*` events are the app's own).

## Slots

A module renders `<r-slot name="…">` (`08-template-engine.md`) and fillers insert partials into it. The app fills slots with its own partials, declared in `renox.toml`:

```toml
# renox.toml
[[slots]]
name = "admin.sidebar"                       # the <r-slot name> some module renders
template = "partials/reports-link.html"      # a partial of the app
requires = "report.view"                     # optional: an action from [authz] actions
priority = 200                               # optional, 0-1000, default 100
```

The keys are those of a module's `[[slots]]` (`docs/contracts/manifest.md`). `requires` is checked against the viewer, as an `r-can` without a resource is: a user without the action sees nothing of that filler. Within a slot, fillers render by ascending `priority`, then by module name, and the app comes after a module's filler of equal priority. The app needs no `permissions.slots`.

`renox check` and `renox build` refuse a filler whose `template` is not a partial of the app and a `requires` that is not in the merged actions. `renox check` warns when no installed module (nor the app) renders the slot: the filler shows nowhere until one does.

## App events

The app declares the events it emits in `renox.toml`, with a payload schema, and emits them like a module:

```toml
# renox.toml
[events."app.appointment_booked"]
description = "An appointment was booked."
payload = { type = "object", required = ["appointment_id"], properties = { appointment_id = { type = "string" } } }
```

```ts
// pages/appointments/new.ts (an action)
await ctx.events.emit("app.appointment_booked", { appointment_id: id });
```

Names are `app.<name>` (`<name>` lower case, digits and `_`), at most 64 events; the payload schema uses the same keyword subset as a module's `[exports] events`. The app emits only the names it declared: an undeclared name rejects with `RENOX_MODULE_UNDECLARED` and a payload that does not match its schema with `RENOX_EVENT_PAYLOAD`, as for a module. A module cannot emit an `app.*` name.

Every installed module may handle an `app.*` event in its `hooks.ts` `on`, without a dependency, and so may the app itself (to move slow work out of the request). Contract: `docs/contracts/artifact.md` 1.8 (the manifest `events` map) and `ops.md` 1.12.0, section 15.4.

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
| `hooks` | services | `run(name, payload)` for modules that expose hook points (the app fills hook points from `hooks.ts`, it does not run them) |
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
