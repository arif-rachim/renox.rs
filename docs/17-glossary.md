# 17 — Glossary

| Term | Meaning |
| --- | --- |
| Action (authz) | A named permission such as `invoice.refund`, declared by a module and referenced in policies, guards, and templates |
| Action (page) | An exported function in a page's `.ts` invoked by `POST ?/name`, usually from a form or htmx |
| ADR | Architecture decision record; see `13-decisions.md` |
| Artifact | The immutable, content-addressed output of `renox deploy`: eszip + templates + policies + manifest |
| Authorizer | SQLite's `sqlite3_set_authorizer` callback, used to restrict a module connection to its own table prefix |
| Cell | The execution unit of one tenant on one node: V8 isolate(s) + SQLite file + realtime connections + outbox worker |
| Context (V8) | A JavaScript global scope inside an isolate |
| Context (`ctx`) | The per-request object passed to loaders, actions, functions, and handlers |
| Control plane | The Bun services that manage tenants, deployments, billing, and the registry |
| Data plane | The Rust worker that runs tenant code |
| Deployment | One version of a tenant's application, identified by artifact hash |
| Durable event | An event stored in `renox__outbox` in the same transaction as the data and delivered at least once |
| eszip | Deno's archive format for a module graph; used for tenant bundles |
| Fragment | A named template block (`r-fragment`) that can be rendered alone for htmx requests |
| Fuel | minijinja's execution-step budget, used to bound template rendering |
| Gateway | The Rust entry point: TLS, routing hostname → tenant → cell, rate limiting |
| Guard | `export const guard = { action }` on a route; evaluated before the handler |
| Hook | A named extension point exposed by a module (`auth.after_login`) that other modules fill, in priority order, with the ability to halt |
| Isolate | A V8 instance with its own heap; one per active deployment (plus one per marketplace module in `isolate` mode) |
| Loader | The `load()` function of a page; returns template data or a `Response` |
| Marshaling | Converting values between V8 and Rust (`serde_v8`) |
| Meter | One record per invocation with CPU, wall time, memory, egress, db time, and render fuel |
| Module | A mini app (auth, billing, admin) installable into a tenant application |
| Module Broker | The Rust component that routes service calls, events, hooks, and slots between modules and enforces dependencies |
| Outbox | The `renox__outbox` table holding durable events |
| Principal | The authenticated end user (or `System::"<module>"`) in a policy evaluation |
| Public view | A versioned SQL view (`billing__public_user_plans_v1`) exported by a module as its read contract |
| Service call | A synchronous call from one module to another's exported function via the broker |
| Slot | A named insertion point in a module's template that other modules fill |
| Snapshot | A V8 startup snapshot of the platform runtime (Web APIs, Node polyfills, SDK) used to create isolates quickly |
| Tenant | A customer account that owns applications, deployments, and data on Renox |
| Tier | A service level (free, starter, pro) that determines quotas, process isolation, and replication |
| Watchdog | A Rust thread that terminates a request's JavaScript execution when it exceeds its CPU budget |
