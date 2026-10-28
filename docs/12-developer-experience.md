# 12 — Developer experience

A tenant needs one CLI and an editor. Dev mode runs the same data plane as production locally, with SQLite, so laptop and server behave the same.

| Command | Purpose |
| --- | --- |
| `renox new <name>` | Project from a template (`shop`, `saas`, `blank`) |
| `renox dev` | Local server: hot reload, error overlay, type generation, local dashboard |
| `renox add <module>` | Add a module, update `renox.lock`, show requested permissions |
| `renox migrate` | Run migrations for all modules in dependency order |
| `renox check` | Type check TS, validate templates and policies, detect route conflicts and broken module contracts, lint unsafe SQL |
| `renox test` | Run TS tests in the production runtime, including policy test cases and per-role template snapshots |
| `renox deploy` | Bundle, upload, validate, activate; `--rollback <hash>` |
| `renox logs --follow` | Tenant logs |
| `renox authz explain` | Explain a policy decision |
| `renox db shell` / `renox db export` | Open the local SQLite file; export a tenant's file from production |

## Dev loop

1. A file watcher detects a change.
2. Only the changed file is processed: TS transpiled (swc), templates transpiled to minijinja and recompiled.
3. The isolate is discarded and recreated from the snapshot (D19). SQLite connections stay open.
4. The browser is refreshed via SSE; if only a template changed, only the fragment is swapped.

Target from save to browser update: under 300 ms for a single file. Discarding the isolate costs tens of milliseconds and removes the memory-leak risk of hot-swapping contexts.

## Type safety

`renox dev` generates `.renox/types/`: `LoaderContext`, `params` per route (from file names), each module's services, event payloads, policy action names, and fragment names. Type checking happens in the editor through `tsc`/tsgo; the runtime does not type check so reloads stay fast.

## Debugging

- TS → JS source maps ship in the bundle and are mapped by the Deno runtime, so stack traces point at the original TS lines.
- Errors from Rust ops (query, fetch, render) are wrapped as JS errors with context (table name, host, template name and line).
- In dev, elements hidden by `r-can` are shown as placeholders with the name of the deciding policy.
- `renox dev --inspect` exposes the V8 inspector for breakpoints in VS Code.

## Client-side errors

Server errors alone are not enough: an exception in an Alpine component or an island, an htmx fragment that returned an error or found no swap target, a script blocked by the CSP, or a WebSocket that cannot connect would otherwise leave a page that "does nothing". The platform captures these from the browser (`docs/contracts/client-events.md`, #125):

- Every response carries `x-renox-request-id`; pages also carry it in a `<meta name="renox-request-id">` tag, fragments in the header (`docs/contracts/client-events.md` section 1). A browser error is reported with the id of the page or fragment on screen, so the dashboard and the overlay show the server log line and the browser error for the same request side by side.
- A small platform script (`/__renox/client.js`, ≤ 4 KB, nonce'd under the strict CSP) captures `window.onerror`, unhandled rejections, the htmx error events, realtime connect and close failures, and CSP violation reports, and sends batches to `/__renox/events` on the app's own origin with `sendBeacon` (#126, #127).
- The gateway validates and rate-limits the events before writing them to the tenant log sink with `source=client`; the endpoint always answers `204` and never touches the isolate. Limits (contract section 6): 32 KB and 20 events per batch, 2,048 code points per string, 60 requests per minute per IP per tenant, 1,000 events per minute per tenant then sampled 1 in 10, and a daily cap tied to the tenant's log allowance.
- In dev the overlay has a "Browser" tab, `renox dev` prints `[browser] …` lines, and the MCP `dev_errors` tool returns the same events. A `renox:error` DOM event lets the app show its own toast.
- In production the dashboard groups events by fingerprint per deployment, flags regressions, and symbolicates frames against sourcemaps that `renox deploy` uploads privately (never served) (#128).
- Privacy (contract section 8): no cookies, form values, or storage are read; no user id, only a random per-page-load `session_fingerprint`; URLs lose their fragment; stack frames keep file, line, column, and function only; strings are truncated at 2 KB; `[client] events = false` in `renox.toml` disables the script and the endpoint.

## Deploy without downtime

1. `renox deploy` produces an artifact with a content hash.
2. The control plane validates it and runs migrations (forward-only, so the old deployment keeps working during the switch).
3. The new isolate is prepared alongside the old one.
4. The route pointer is switched atomically; in-flight requests finish on the old version.
5. Rollback is a pointer switch to the previous hash.

## Build and compile strategy (for platform developers)

Two different people compile things, and the experience must differ.

| Who | Writes | Compiles | Expected feedback loop |
| --- | --- | --- | --- |
| Tenant developer | TypeScript, HTML, SQL | Nothing. TS is transpiled (types stripped) in milliseconds; templates are re-transpiled in milliseconds | Save → browser in ≤ 300 ms; `renox test` runs hundreds of TS tests in seconds inside the prebuilt runtime |
| Platform developer (us) | Rust data plane, plus TypeScript control plane, CLI, SDK, modules | Rust only for the data plane; everything else is Bun with no build step | `cargo check` in seconds for a leaf crate; full release build only in CI when Rust changes |

Tenants never touch Rust. The pain of Rust compile times is confined to the data plane, and the rules below keep it small.

### Rules

1. **Never compile V8.** Use prebuilt `rusty_v8` binaries (the default of the `v8` crate). V8 from source is 30–60 minutes and is never part of our build. Pin the version.
2. **Small crates, strict boundaries.** `renox-data`, `renox-template`, `renox-authz`, `renox-realtime`, `renox-meter`, `renox-gateway` are leaf crates that do not depend on the runtime or on each other. Editing the template engine recompiles only that crate. Integration happens only in `renox-cell`.
3. **Fast linking and incremental builds.** `mold` (Linux) or `lld` as the linker; `cargo watch -x check` during iteration; `opt-level = 1` for dependencies in the dev profile; `debug = 1` to cut debuginfo size.
4. **Tests without V8 wherever possible.** The template engine is tested as string in → string out; the authorizer and migrations against a real SQLite file; Cedar policies against policy files; the gateway with in-memory requests. Only `renox-runtime` and `renox-cell` link V8, and their tests run less often (CI and on demand).
5. **Dev-mode runtime is prebuilt.** `renox dev` ships the compiled worker, so the tenant feedback loop never includes a Rust build. The same prebuilt worker is used for `renox test`.
6. **CI caches everything.** `sccache` + cached `target/`; the release build of `renox-worker` runs only when `crates/` changes. Docs, TypeScript, and module changes never trigger a Rust build. Target: CI ≤ 15 minutes with a warm cache (B20).
7. **Most of the platform is not Rust.** Control plane, CLI, SDK, and all official modules are TypeScript on Bun. Expected split of code we write: roughly 30–40% Rust (data plane glue over Supabase Edge Runtime), 60–70% TypeScript.
8. **`unsafe` and FFI stay in two places.** V8 and SQLite wrappers only, documented and reviewed. This keeps compile-heavy, hard-to-test code isolated.

### Expected numbers (targets, measured under B20)

| Build | Cold | Warm (one leaf crate changed) |
| --- | --- | --- |
| `cargo check` workspace | ≤ 3 min | ≤ 5 s |
| `cargo build` debug (with V8 prebuilt) | ≤ 6 min | ≤ 20 s |
| `cargo test` leaf crates (no V8) | ≤ 1 min | ≤ 10 s |
| `cargo build --release renox-worker` (CI) | ≤ 15 min with cache | — |

If these targets are missed, the fix is more crate splitting or moving logic out of the V8-linked crates, not accepting slower loops.

## Observability

OpenTelemetry tracing per request: spans for the loader, each service call, query, render, and outbound fetch. Metrics per tenant and per route: latency, error rate, CPU ms, heap, egress. Structured logs always include `tenant_id`, `request_id`, and module name. Tenants see their own traces and metrics in the dashboard.
