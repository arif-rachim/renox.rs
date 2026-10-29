# 12 — Developer experience

A tenant needs one CLI and an editor. Dev mode runs the same data plane as production locally, with SQLite, so laptop and server behave the same.

| Command | Purpose |
| --- | --- |
| `renox new <name>` | Project from a template (`shop`, `saas`, `blank`) |
| `renox dev` | Local server: hot reload, error overlay, type generation, local dashboard |
| `renox add <module>` | Add a module, update `renox.lock`, show requested permissions |
| `renox migrate` | Run migrations for all modules in dependency order |
| `renox check` | Type check TS, validate templates and policies, detect route conflicts and broken module contracts, lint unsafe SQL, scan for secrets (`--secrets`: only the secret scan) |
| `renox test` | Run TS tests in the production runtime, including policy test cases and per-role template snapshots |
| `renox deploy` | Bundle, upload, validate, activate; `--rollback <hash>` |
| `renox logs --follow` | Tenant logs |
| `renox authz explain` | Explain a policy decision |
| `renox db shell` / `renox db export` | Open the local SQLite file; export a tenant's file from production |

### Installing the CLI

The CLI is released as standalone binaries (`bun build --compile`, so no Bun is needed) for Linux and macOS on x64 and arm64. A `cli-v<version>` tag runs `.github/workflows/release-cli.yml`, which publishes `renox-<version>-<os>-<arch>` with a `.sha256` for each binary, `install.sh`, and `worker-version.txt`. That file holds the `renox-worker` version the CLI is tested against: `WORKER_VERSION` in `cli/scripts/fetch-worker.ts`, whose release must exist before the CLI release. `curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v<version>/install.sh | sh` (source: `cli/scripts/install.sh`) installs into `~/.renox/bin`. It installs `renox` and the pinned `renox-worker` for the platform, and installs a file only when its SHA-256 matches. Override with `RENOX_VERSION`, `RENOX_INSTALL_DIR` and `RENOX_RELEASE_BASE`, or skip the worker with `RENOX_NO_WORKER=1`. `renox new`, `renox check`, and `renox build` of an app without `templates/` run without the worker; `renox dev` and the template transpile of `renox build` find the installed worker beside `renox`.

Releases are signed (#129; `docs/24-threat-model.md` F, "Tampered release"). Every `cli-v*` and `worker-v*` release also carries `SHA256SUMS`, a sigstore bundle `<asset>.sigstore.json` per file (cosign keyless signature from the release workflow's OIDC identity, logged in Rekor), and SLSA v1 build provenance (`renox-<version>.provenance.sigstore.json`, `renox-worker-<version>.provenance.sigstore.json`). The release workflow verifies all of them with cosign in a fresh container before it publishes. With `cosign` installed, `install.sh` also checks each file's signature and installs nothing that fails; `RENOX_REQUIRE_SIGNATURE=1` refuses to install without a verified signature. To verify a download by hand:

```sh
v=0.1.0; a=renox-$v-linux-x64
sha256sum -c --ignore-missing SHA256SUMS
cosign verify-blob --bundle $a.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/arif-rachim/renox\.rs/\.github/workflows/release-cli\.yml@refs/tags/cli-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com $a
cosign verify-blob-attestation --bundle renox-$v.provenance.sigstore.json --new-bundle-format --type slsaprovenance1 \
  --certificate-identity-regexp '^https://github\.com/arif-rachim/renox\.rs/\.github/workflows/release-cli\.yml@refs/tags/cli-v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com $a
```

For a worker use `release-worker\.yml@refs/tags/worker-v` and the worker release's files. The CLI checks the worker before it runs it: the downloaded or installed worker must have the sha256 of the pinned release for its platform, baked into the CLI (`PINNED_WORKER` in `cli/src/worker/verify.ts`, checked against the worker release when the CLI is released); `renox dev --worker <path>` also accepts a binary whose `<path>.sigstore.json` and the release's provenance bundle beside it verify with cosign as above. Anything else stops with `RENOX_CLI_WORKER_UNVERIFIED` (exit code 3) and the expected and actual sha256. `RENOX_WORKER_PATH` is the unverified override for a worker built from source.

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

Server errors alone are not enough: an exception in an Alpine component or an island, an htmx fragment that returned an error or found no swap target, or a script blocked by the CSP would otherwise leave a page that "does nothing". The platform captures these from the browser (`docs/contracts/client-events.md`, #125):

- Every response carries `x-renox-request-id` (the gateway sets it on every response, its own 400, 431, 429, and 503 included). Pages also carry it in `<meta name="renox-request-id">`, with `<meta name="renox-deployment">` and, on error pages, `<meta name="renox-error-code">`; fragments carry it in the header only (contract section 1). A browser error is reported with the id of the page or fragment on screen, so the overlay shows the server log and the browser error of the same request on one screen.
- The platform script `/__renox/client.js` (`sdk/client/`, about 2.5 KB gzipped, CI fails above 4 KB) is the first thing in every page's `<head>`, with the request's CSP nonce. It captures `window` errors (message, file, line, column, stack frames), unhandled rejections, `htmx:responseError` (status and the `RENOX_*` code from the JSON body or the error page's meta tag, with the failed request's own id), `htmx:sendError`, `htmx:timeout`, `htmx:targetError`, `htmx:swapError`, and `securitypolicyviolation`. Identical events within 10 s are sent once, at most 50 per page load, in batches of up to 20 to `/__renox/events` with `sendBeacon` (fetch `keepalive` as fallback), at the latest one second after the first event or when the page is hidden. `<meta name="renox-events-sample" content="0.1">` keeps one page load in ten. Realtime events (`renox.realtime.connect()`) come with F5 (#70).
- **`renox:error` hook.** Every captured event is also dispatched on `document` as a `renox:error` DOM event whose `detail` is the event as sent, so the app can show its own toast: `document.addEventListener("renox:error", (e) => toast(e.detail.kind))`. `renox.client.setExtra({ plan: "pro" })` adds up to 16 tenant fields (1 KB) to later events.
- The gateway validates and rate-limits the events per IP and per tenant before writing them to the tenant log sink with `source=client`; the endpoint never touches the isolate and always answers 204. The endpoint, batch format, and limits (32 KB body, 20 events, 60 requests per minute per IP, 1,000 events per minute per tenant then sampled, a daily cap) are in `docs/contracts/client-events.md` sections 2, 3, and 7. CSP reports from the browser itself (`report-uri`, `report-to renox-csp`) go to the same endpoint.
- **In dev** (`renox dev`): the proxy marks every page with `<meta name="renox-dev">`, which also turns on `console.error` capture, and handles the batches itself, so nothing is dropped or sampled. Each event is printed in the terminal next to the server lines, for example `[browser] js.error pages/products/[id].html:42:7 TypeError: cart is undefined (01JBQ3Z7MA…)` (an inline script's errors name the page's template; the line is the line in the served HTML), and an event with a `RENOX_*` code gets the catalogue's hint. The overlay's "Browser" tab lists the events with source, line, column, stack, and request id; "Server log for <id>" shows the server side of that request (code, limit, cpu_ms, heap) in the same panel. The MCP `dev_errors` tool returns them as `browserErrors` (`kind`, `message`, `request_id`, `url`, `code`, `detail`). The events are kept in `.renox/logs/browser.ndjson`.
- In production the dashboard groups events by fingerprint per deployment, flags regressions, and symbolicates frames against sourcemaps that `renox deploy` uploads privately (never served) (#128).
- Privacy: no cookies, form values, or storage are read; URLs other than the page's lose their query and fragment; stack frames keep file, line, column, and function only (`docs/contracts/client-events.md` section 8). `[client] events = false` in `renox.toml` is to disable the script and the endpoint once the manifest carries it (contract Open 1; the worker already reads `client.events`).

## Deploy without downtime

1. `renox deploy` produces an artifact with a content hash.
2. The control plane validates it and runs migrations (forward-only, so the old deployment keeps working during the switch).
3. The new isolate is prepared alongside the old one.
4. The route pointer is switched atomically; in-flight requests finish on the old version.
5. Rollback is a pointer switch to the previous hash.

## Concurrency and the blast radius

A quiet deployment runs in one isolate. When requests start waiting on a busy isolate, the worker grows a pool of isolates for that deployment (up to 2 on the free tier, up to one per core and at most 8 on paid tiers), keeps one spare ready, and sends each request to the least-loaded isolate (#156). A request that hits the CPU or heap limit ends its own isolate and every request in flight on that isolate, which get the same 503 code; requests on the other isolates of the pool carry on, and the spare takes the dead isolate's place. Module-level state (in-memory caches, counters) lives per isolate, so two requests of one deployment can see different copies: keep shared state in `ctx.db`. The concurrency limit (50 free, 500 paid) counts the requests of the whole pool.

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
   **CI minutes (#189).** Every check sits in one of three jobs: `lint` (path filter, pinned actions, `cargo-deny`, `bun audit`, and the docs checks when docs change) runs on every push and PR, `rust` and `ts` only when their paths change, so a docs-only PR bills one job. On a pull request `rust` tests only the crates that changed and the workspace packages that depend on them (`make rust-test CRATES=...`); a change outside `crates/` (lockfile, toolchain, `ops/`, the workflow) tests the whole workspace, and so does every push to `main`. `release-worker.yml` runs on `worker-v*` tags, by hand, and once on `main` after a merge that touches the packaging, never on a pull request. Quota decision, taken by the owner on 2026-10-28 when 1,800 of the plan's 2,000 monthly minutes were used: option (c), the repository is public, so standard GitHub-hosted runners are not metered. Rejected: (a) a paid spending limit for overage (USD 0.008 a Linux minute), kept as the fallback if the repository ever goes private again; (b) a self-hosted runner for `rust` on the owner's build machine, which on a public repository would run code from fork pull requests on that machine. The job folding stays because it shortens the PR feedback loop and the concurrency queue.
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
