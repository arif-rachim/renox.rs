# 02 — Comparison with other frameworks and platforms

Users choose a platform for its ecosystem, time-to-product, risk, and cost, not for its runtime. The matrices below map the needs of Renox's target users (`01-business.md`) against the available options.

Legend: ✅ present and mature · ⚠️ partial or needs work · ❌ absent.

## A. Application frameworks vs needs

| Need | Next.js | Remix / RR7 | SvelteKit / Nuxt | Astro | Deno Fresh | Laravel | Rails | Django | Phoenix | AdonisJS | **Renox** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Logic in TypeScript | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| SSR + static | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| HTML-first without SPA | ❌ | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ Livewire | ✅ Hotwire | ⚠️ HTMX | ✅ LiveView | ⚠️ | ✅ htmx |
| Built-in auth | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ module |
| Built-in admin, billing | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ packages | ⚠️ gems | ✅ admin | ❌ | ❌ | ✅ modules |
| Composable modules (install = done) | ❌ | ❌ | ❌ | ⚠️ integrations | ❌ | ✅ packages | ✅ engines | ✅ apps | ⚠️ | ⚠️ | ✅ |
| No build step for the developer | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Production memory per app | ❌ 200–500 MB | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ 2–10 MB |
| Easy self-hosting | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (hosted) |
| Ecosystem and hiring | ✅ largest | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ⚠️ | ❌ | ❌ new |
| Long-term API stability | ❌ churn | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ❌ new |

Conclusion: the combination "TypeScript + HTML-first + batteries-included + modules + low memory" is empty. The closest competitors by model are Laravel/Rails (different language) and AdonisJS (no modules, no hosting).

## B. Hosting platforms vs needs

| Need | Vercel | Cloudflare Workers | Deno Deploy | Supabase | Fly.io | Railway / Render | PocketBase (self-host) | **Renox** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Deploy TS without Docker | ✅ | ✅ | ✅ | ✅ fn | ⚠️ | ⚠️ | ❌ | ✅ |
| Sandbox for third-party code | ✅ | ✅ isolate | ✅ isolate | ✅ isolate | ✅ microVM | ✅ container | ❌ | ✅ isolate + process |
| Idle tenants nearly free | ⚠️ | ✅ | ✅ | ⚠️ | ⚠️ scale-to-zero | ❌ | ✅ | ✅ |
| Built-in per-tenant database | ❌ | ✅ D1 | ✅ Deno KV | ✅ Postgres | ❌ | ⚠️ | ✅ SQLite | ✅ SQLite |
| Built-in HTML-first SSR | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Installed auth/billing/admin modules | ❌ | ❌ | ❌ | ⚠️ auth, storage | ❌ | ❌ | ⚠️ auth, admin | ✅ |
| UAE local payments, BNPL, FTA tax invoices | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ GCC modules |
| AED pricing, data in the UAE | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | n/a | ✅ |
| Node compatibility | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | n/a | ✅ via Deno |

Supabase and Cloudflare are the closest architectural comparables (isolates + per-tenant DB). The difference is in the application model (SSR + modules) and the market (local pricing and payments).

## C. Isolation models for hosting third-party code

| Model | Memory per idle tenant | Cold start | Isolation strength | npm compatibility | Used by | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Process per tenant (Bun/Node) + cgroups | ~30–50 MB | ~10–30 ms | Strong (OS) | Best | Fly.io/Railway pattern | Rejected: 5–10x less dense |
| MicroVM per tenant (Firecracker) | ~100 MB+ | ~100 ms+ (faster with snapshots) | Very strong | Best | AWS Lambda, Fly.io | Only for the top tier / suspicious tenants |
| **V8 isolate per tenant** | **~2–10 MB (F1 measured 7.4 MB `hello`, 11.1 MB `shop`, provisional)** | **~1–10 ms to create; F1 cold start p50 22 ms including the tenant file and the first request (provisional)** | Adequate; must be layered with a process sandbox | Good via Deno | Cloudflare, Deno Deploy, Supabase, Vercel Edge | **Chosen (D2, D3, D6)** |
| Wasm per tenant (wasmtime) | < 1 MB | < 1 ms | Very strong | Poor for JS | Fermyon, Fastly | Future option for non-JS functions |

Numbers are ranges from those platforms' publications; Renox targets are in `14-benchmarks.md`.

## D. JavaScript engines for the data plane

| Engine | Memory per instance | Speed | Compatibility | Per-tenant sandbox | Decision |
| --- | --- | --- | --- | --- | --- |
| V8 via Supabase Edge Runtime / `deno_runtime` | ~2–10 MB (F1 measured 7.4–11.1 MB, provisional) | JIT, fastest | `npm:`, `node:*`, Web APIs | ✅ heap limit, terminate, op permissions | **Chosen (D3)** |
| V8 via raw `deno_core` | ~2–5 MB | Same | Web APIs and Node compat must be built | ✅ | Rejected: scope |
| Bun (JavaScriptCore) | ~30–50 MB per process | JIT, on par with V8 | Very good | ❌ no isolates | Used for the control plane (D4), not for tenants |
| QuickJS (`rquickjs`) | < 1 MB | 10–50x slower (no JIT) | Many npm packages fail | ✅ | Rejected: SSR and libraries need speed |
| Boa (pure Rust) | Small | Slower, incomplete | Limited | ✅ | Watching |

## E. Databases for tenant data

| Option | Tenant isolation | Idle tenant cost | Latency | Per-tenant backup | Write concurrency | Features | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **SQLite per tenant** | File per tenant (strongest) | 0 | µs, in-process | Copy file / Litestream | 1 writer per file | FTS5, JSON, sqlite-vec; no RLS | **Chosen (D5)** |
| Postgres, schema per tenant | RLS/search_path (1 bug = leak) | Catalog bloat at tens of thousands of schemas | Hundreds of µs–ms | Hard | High | Complete | Rejected as default |
| Postgres, DB per tenant | Good | 5–10 MB per backend connection | Hundreds of µs–ms | `pg_dump` | High | Complete | Upgrade path for large tenants |
| Shared Postgres + tenant_id | Weak | Small | Hundreds of µs–ms | Hard | High | Complete | Rejected |
| Managed Turso/libSQL | File per tenant | Small | Network | Built-in | 1 writer | SQLite-like | Operational alternative if we do not want to run replication ourselves |

## F. Template engines

| Option | Syntax | Runtime-loadable | Speed | Safety for tenant templates | Decision |
| --- | --- | --- | --- | --- | --- |
| minijinja | Jinja | ✅ | Very fast, built-in fuel | DSL, no code | **Used as the transpile target (D8)** |
| HTML attributes (`r-if`, `r-for`) | Valid HTML | ✅ | Follows the target | Same | **Chosen as the syntax (D8)** |
| Askama | Jinja, compile-time | ❌ | Fastest | n/a | Rejected: requires a Rust compile |
| Tera | Jinja | ✅ | Slower than minijinja | DSL | Rejected |
| JSX/TSX in the isolate | JS | ✅ | Charged to the tenant quota | Full code | Secondary option |
| Custom engine | Any | ✅ | Unknown | Must be built | Rejected: scope |

## G. Policy engines for authorization

| Option | Host language | RBAC | ABAC | Relations | Schema validation | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| **Cedar (`cedar-policy`)** | Rust | ✅ | ✅ | ✅ | ✅ | **Chosen (D15)** |
| OPA / Rego | Go (sidecar) | ✅ | ✅ | ⚠️ | ⚠️ | Rejected: separate process |
| Casbin (`casbin-rs`) | Rust | ✅ | ⚠️ | ⚠️ | ❌ | Rejected: ABAC not expressive enough |
| OpenFGA / Zanzibar | Go (service) | ⚠️ | ❌ | ✅ | ✅ | Rejected: separate service, overkill |
| TypeScript predicates | JS | ✅ | ✅ | ✅ | ❌ | Rejected: not analyzable, charged to tenant quota |

## H. "Why not just use X?"

| Question | Short answer |
| --- | --- |
| Why not Bun + Hono + HTMX? | For our own apps that is enough and 3–5x cheaper to build. For hosting other people's code Bun has no isolates: one process per tenant means 5–10x lower density. Renox uses Bun for the control plane (D4). |
| Why not fork Supabase? | Supabase is Postgres + functions. Renox adds the application model (SSR, modules), SQLite per tenant for density, and the local market. Its Edge Runtime is in fact our foundation (D3). |
| Why not PocketBase? | A single Go binary without multi-tenancy, SSR, or modules. It proves demand; it is not a direct competitor. |
| Why not Postgres with RLS? | For multi-tenant with a long tail, idle-tenant cost and the risk that one RLS bug leaks every tenant are worse than a file per tenant. Postgres remains the upgrade path (D5). |
| Why not run Next.js on Renox? | Next.js depends on Node internals and a Vercel-centric build. Web-standard frameworks (Hono, SvelteKit, Remix) can technically run in an isolate but are not an initial focus. |
| Why Rust if V8 does the JS work? | Rust controls the isolates: heap limits, watchdog, op permissions, scheduling, in-process SQLite, rendering outside the tenant quota. That is the part that sells. |
