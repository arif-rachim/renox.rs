# 10 — Module system and inter-module communication

A module is a mini app with the same folder structure as an app, processed by the same loader. Official modules (auth, org, 2fa, billing, admin, storage) are Renox's main product: the reason tenants choose the platform. The catalog and build order are in `18-build-plan.md`.

```
modules/billing/
├── module.toml     manifest
├── migrations/     SQL (SQLite dialect), tables billing__*
├── pages/  functions/  partials/  public/
├── policies/       default Cedar policies
├── services.ts     public contract for other modules
└── hooks.ts        event handlers, hooks, middleware
```

```toml
[module]
name = "billing"
version = "1.2.0"

[dependencies]
auth = "^1.0"
org  = "^1.0"

[config]
provider = { type = "enum", values = ["stripe", "checkout", "telr", "paytabs", "ngenius"] }
currency = { type = "string", default = "AED" }

[permissions]
network = ["api.stripe.com", "api.checkout.com", "secure.telr.com", "secure.paytabs.com", "api-gateway.ngenius-payments.com"]
tables  = "billing__*"
secrets = ["BILLING_PROVIDER_KEY"]

[exports]
views = ["billing__public_user_plans_v1"]

[[slots]]
name = "admin.sidebar"
template = "partials/admin-menu.html"
requires = "invoice.read"

[[tools]]                       # exposed through the app's MCP endpoint (see 20-ai-agents-mcp.md)
name = "create_invoice"
file = "tools/create-invoice.ts"
action = "invoice.create"
confirm = false
```

```toml
# renox.toml (tenant app)
[modules]
auth    = { version = "^1.0" }
org     = { version = "^1.0" }
billing = { version = "^1.2", mount = "/billing", config = { provider = "telr" } }
reports = { registry = "acme/reports", version = "^0.4", isolation = "isolate" }
```

At deploy: resolve versions and write `renox.lock`; build the dependency graph (cycles rejected); run migrations in topological order; merge routes under `mount` prefixes (conflicts rejected); register services, events, hooks, and slots with the Module Broker.

## Module isolation modes (D12)

| Mode | How it works | Call cost | For |
| --- | --- | --- | --- |
| `shared` (default) | All modules bundled into one context in the tenant's isolate | Plain JS function call, no serialization | The tenant's own modules and official modules |
| `context` | Separate context inside the tenant's isolate | Microseconds + serialization | Modules that need separate globals |
| `isolate` | Own isolate with its own heap limit, inside the tenant's sandboxed process | More expensive, cross-isolate | Marketplace modules |

Regardless of mode, table permissions are enforced by the SQLite authorizer and network permissions by the `fetch` op, never by JavaScript convention.

## Five communication mechanisms

| Mechanism | Nature | Needs declared dependency | Use when |
| --- | --- | --- | --- |
| Service call | Synchronous | Yes | You need an answer now |
| Event | Asynchronous, fire-and-forget | No | Announcing that something happened |
| Hook | Synchronous, ordered, can halt the flow | No | Participating in another module's process |
| Public view | Read-only SQL, versioned | Yes | Joins across modules without N+1 |
| Slot | Template insertion | No | UI inside another module's page |

### Service call

```ts
// modules/billing/services.ts
export async function getActivePlan(ctx, userId: string): Promise<Plan | null> { /* ... */ }

// caller
import { billing } from "renox:modules";
const plan = await billing.getActivePlan(user.id);   // ctx is supplied by the broker
```

The broker checks that the caller declared the dependency, supplies the target module's `ctx` (db with that module's authorizer, its config, the same user, transaction, request id, and deadline), and generates `renox-modules.d.ts` for type checking.

### Event

```ts
// modules/billing/functions/webhook.ts
await ctx.events.emit("billing.invoice_paid", { userId, invoiceId, amount });

// modules/email/hooks.ts
export const on = {
  "billing.invoice_paid": async (ctx, e) => ctx.mail.send(e.userId, "invoice-paid", e),
};
```

| | In-process | Durable (default) |
| --- | --- | --- |
| Execution | Immediately, in the same request | After commit, by the cell's outbox worker |
| Handler fails | Request fails | Retry with exponential backoff, then dead-letter |
| Server restarts | Event lost | Still delivered |
| Guarantee | Exactly once within the request | At-least-once; handlers are idempotent using `e.id` |

Durable events are rows in `renox__outbox` written in the same transaction as the data (D14). The outbox worker is woken by SQLite's `update_hook`, not by polling.

### Hook

```ts
// modules/auth/services.ts — auth EXPOSES a hook point
const result = await ctx.hooks.run("auth.after_login", { user });
if (result.halt) return result.response;

// modules/2fa/hooks.ts — 2fa FILLS it
export const hooks = {
  "auth.after_login": { priority: 10, async handle(ctx, { user }) {
    if (await isEnabled(ctx, user.id)) return { halt: true, response: ctx.redirect("/2fa/verify") };
  }},
};
```

### Public view

```sql
-- modules/billing/migrations/003_public_view_v1.sql
create view billing__public_user_plans_v1 as
  select user_id, plan_name, renews_at from billing__subscriptions where active = 1;
```

Modules that declare `billing` as a dependency may read this view (authorizer allows `SELECT`) and join it with their own tables. Internal tables stay private, so billing can change its schema as long as the view stays compatible. Views are versioned (`_v1`); the previous version is kept for at least one major release (D17).

### Slot

```html
<!-- modules/admin/pages/_layouts/admin.html -->
<nav><r-slot name="admin.sidebar" /></nav>
```

Slot contents are evaluated with the providing module's actions (`requires` in its manifest), so a menu entry disappears for users without access.

## Cross-module transactions

```ts
return ctx.db.transaction(async () => {
  const order   = await orders.create(cart);
  const invoice = await billing.createInvoice(user.id, order);
  await inventory.reserve(order.items);     // failure → order and invoice roll back
});
```

The broker uses the tenant's single writer connection for the whole transaction and passes it to every service call. This is the main advantage of the in-process architecture over microservices.

## Overrides and migrations

- Module templates can be overridden under `overrides/<module>/...`; logic cannot. The original file's hash is stored, and a diff is shown on upgrade.
- Migrations are forward-only with expand/contract (D17). Public views are versioned.

## Rules

1. Service calls and public views require explicit dependencies; cycles are rejected at deploy.
2. A module writes only to tables with its own prefix; other modules' data is reached through services, events, or views.
3. Event names, service signatures, hook names, slot names, views, and MCP tools are a module's public API, versioned with semver. `renox check` detects missing contracts.
4. Per-request data goes through `ctx`; module globals are shared across requests and may only hold intentional caches.
