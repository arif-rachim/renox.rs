# renox-cell

The worker node (P5, `docs/03-architecture.md` Cell row): wires `renox-gateway`, `renox-runtime`, `renox-data`, and `renox-meter` into one process, the `renox-worker` binary. A **cell** is one tenant deployment on this node: its V8 isolate plus its share of the tenant's SQLite file (`docs/17-glossary.md`). Only this crate depends on the other four; nothing depends on it.

```
cargo run -p renox-cell --bin renox-worker -- --config crates/renox-cell/worker.example.toml
cargo test -p renox-cell        # tests/two_tenants.rs links V8
```

## Configuration

`renox-worker --config worker.toml`. Relative paths are resolved against the config file's directory. Unknown keys are refused. Example: `worker.example.toml`.

| Key | Default | Meaning |
| --- | --- | --- |
| `listen` | — | Address of the gateway (plain HTTP in F1; TLS is `Gateway::serve_tls`, wired when certificates arrive from the control plane, F3) |
| `data_dir` | — | `<data_dir>/<tenant_id>/app.db` (the tenant file) and `<data_dir>/<tenant_id>/secrets.json` |
| `artifacts_dir` | — | Artifact directories named by their content hash (`docs/contracts/artifact.md`); also the gateway's static file root |
| `routes_file` | — | The route table (`docs/contracts/schemas/route-table.schema.json`); re-read on `SIGHUP` |
| `meters_dir` | — | Meter batches, `<meters_dir>/<YYYY-MM-DD>.ndjson`; dead letters under `dead/` (`docs/contracts/meter.md`) |
| `logs_dir` | — | Tenant log lines, `<logs_dir>/tenant.ndjson` (one JSON object per line, secrets redacted) |
| `node_id` | `node-local` | Written into meter batches (`cell_id` and `node_id`) |
| `idle_timeout_secs` | 600 | Scale to zero: a cell without a request for this long is evicted |
| `meter_flush_ms` | 5000 | Meter batches are written at least this often |
| `fetch_blocked_addresses` | `[]` | The node's own public addresses and the control plane's; tenant `fetch` is refused to them on top of the private ranges. Empty logs a warning at start; set it in production |
| `default_tier` | `free` | Tier of tenants not listed in `tenant_tiers` |
| `[gateway]` | 100 / 200 / 100 | `rate_limit_per_ip` (req/s), `rate_limit_burst`, `max_connections_per_ip`: the gateway's per-client limits (`renox-gateway` README). Benchmarks that send all load from one address raise them |
| `[tenant_tiers]` | — | `tenant_id = "free" \| "paid"` (F1 stand-in for the control plane) |
| `[tiers.free]`, `[tiers.paid]` | see "Tiers" | Overrides of single tier fields |

Process logs are structured JSON on stderr (`tracing`, filtered by `RUST_LOG`, default `info`). They name tenants, hashes, and request ids, never secret values or request content.

## Tiers

`src/tiers.rs`, defaults from `docs/04-isolation-security.md` ("Per-tenant limits") and `docs/contracts/ops.md` section 10. The manifest's `limits` can only lower them further (`Limits::with_overrides`).

| Field | `free` | `paid` |
| --- | --- | --- |
| `cpu_ms` (per request) | 50 | 500 |
| `wall_ms` (per request) | 30,000 | 60,000 |
| `heap_mb` (per isolate) | 128 | 512 |
| `concurrency` (per deployment) | 50 | 500 |
| `db_quota_bytes` | 100 MB | 10 GB |
| `egress_bytes` (fetch, per request) | 10 MB | 100 MB |
| `log_lines_per_min` (per tenant) | 1,000 | 10,000 |

The gateway's request deadline is the longest tier's wall clock; the runtime then caps each request at its own tier's `wall_ms`.

## Lifecycle

`CellManager` (`src/manager.rs`) implements `renox_gateway::CellDispatcher`. Cells are keyed by `(tenant_id, deployment_hash)`.

| State | What happens |
| --- | --- |
| **starting** | The first request for the key creates the cell; concurrent requests wait for the same creation. Steps: check the tenant id (it is a directory name), find the artifact, open the tenant's `TenantDb` (`app` authorizer, the tier's quota) on its DB thread or share the one already open, run the artifact's app migrations (`migrations/app/*.sql` against `migrations/checksums.json`), read `secrets.json`, create the isolate with the tier's limits. A failure answers 500 `RENOX_INTERNAL` (or the isolate's limit code) and is retried on the next request |
| **ready** | Requests are dispatched to the isolate; the body (already limited by the gateway) is collected, the response is buffered |
| **draining** | After a route table reload, a cell whose `(tenant, hash)` has no `active` entry anymore takes no new route; it is evicted as soon as its in-flight requests finish (`docs/05-tenant-lifecycle.md`, "Deployment switch"). New requests for the new hash create a new cell |
| **evicted** | No request for `idle_timeout`, or drained. The cell is removed from the map under the same lock that admits requests (so no request is admitted to an evicted cell; one arriving now waits for a fresh cell), its isolate is terminated, and the tenant's database is closed with a WAL truncate when no other cell of the tenant uses it. Once no cell was evicted for 2 s, the worker returns freed memory to the OS with glibc `malloc_trim(0)`, and again 10 s and 30 s later (`src/alloc.rs`, #144; B2 0.06 MB per idle tenant) |

One DB thread per tenant file, shared by all cells of the tenant (old and new deployment during a switch): one writer per file, as SQLite requires.

**Meter records.** For every dispatched request that matched a route, the manager completes the runtime's fields (`cpu_ms`, `peak_heap_bytes`, `fetch_*`, `db_ms`, `db_rows`, `logs_dropped`, `status`) with `request_id`, `tenant_id`, `deployment_hash`, `route`, `started_at`, `wall_ms`, `ingress_bytes` (request body), `egress_bytes` (response body), and `http_status`, then `Meter::record`. 404 and 405 from route matching produce no record (`meter.md` section 1).

**Secrets.** `<data_dir>/<tenant_id>/secrets.json` is an object of string values. A missing file means no secrets; a file readable by group or others (mode not 0600) is refused and the cell is not created. Only the names the manifest declares reach the isolate (`renox-runtime`).

## Artifacts

`src/artifact.rs` (#30). `ArtifactStore::get(hash) -> ArtifactDir` is the only way the manager finds code; `LocalArtifactStore(dir)` serves `<dir>/<hash>/` and is the F1 stand-in for object storage (F3 puts the S3 fetch and disk cache behind the same trait, #55). On the first `get` of a hash it checks:

| Rule (`docs/contracts/artifact.md` section 6) | Check |
| --- | --- |
| V1 | Tree walk without following links: symbolic links and special files refused, every path follows the path rules (no `..`, no `\`, no `:`) |
| V2 | The canonical hash (section 2) equals the directory name; a mismatch is `ArtifactError::HashMismatch` |
| V3, V9 | `manifest.json` validates against `docs/contracts/schemas/manifest.schema.json` (`jsonschema`, compiled in), so unknown keys are refused |
| V8 | Route conflicts: same method, same shape (static segments literally, parameter names ignored); repeated parameter names |
| V11 | `migrations/`: `<module>/NNN_<name>.sql` only, numbered from 001 without gaps, `checksums.json` lists exactly those files with matching hashes |

A verified hash is cached (artifacts are never overwritten); a failure is not, so a repaired copy is picked up. `renox-runtime` verifies V1-V7 again each time it creates an isolate from the directory. `canonical_listing` and `hash_files` compute the hash of in-memory files; `docs/contracts/examples/hash-vectors.json` holds vectors shared with the CLI's TypeScript implementation (`tests/artifact.rs` checks both the in-memory and the on-disk path against them).

## Pages

`src/render.rs` (#40). At cell creation the cell loads the artifact's `templates/` into a `renox_template::Renderer` (`PageRenderer`). When a dispatch returns a page render, the cell parses the loader JSON straight into `minijinja::Value` (`serde_json` with `float_roundtrip`) and renders on Tokio's blocking pool, outside the isolate and its CPU limit, under `RenderLimits::DEFAULT`:

| Case | Answer |
| --- | --- |
| Page or selected fragment rendered | 200 `text/html; charset=utf-8`, `Cache-Control: no-store`, `Vary: HX-Request, HX-Target` |
| Out-of-band fragments (an action's `{ fragments }`, wired by #41) | the main output, then each block with `hx-swap-oob="true"` on its first element; an unknown name is 500 |
| Render limit | 500 `RENOX_RENDER_LIMIT`, meter `status: render_limit`, one tenant log line with `template` and `limit` |
| Platform error on a page route (handler threw, bad loader result, CPU, deadline) | the tenant's `pages/_error` with `status`, `code`, `request_id`, `message` under `RenderLimits::ERROR_PAGE`, else the platform default page |
| `GET`/`HEAD` with no matching route, `Accept` preferring HTML | `pages/_404`, else `_error`, else the default page; no meter record |

The meter record gets `render_fuel` and `render_ms` (render-thread CPU time) of every render of the invocation, error page included. Responses are buffered; streaming the layout shell is #161. The CSP nonce argument exists and is `None` until #47 wires the header. `date` uses the app's zone for the Gulf zones (`Asia/Dubai`, ...) and UTC otherwise.

## Not here yet

Artifact fetch from object storage and the disk cache (#55), route updates by pub/sub (F3), the process sandbox (F6), realtime (F5), TLS certificates from the control plane (F3). Requests and responses are buffered; streaming is F2.
