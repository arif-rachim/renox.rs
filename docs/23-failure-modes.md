# 23 — Failure modes and negative paths

Every component in this platform will fail, and tenants will send bad input, on purpose or by accident. This document is the catalogue of those cases: what fails, who detects it, what the tenant sees, what the platform does, and the test that proves the behaviour. It is the source for the "negative path checklist" issue that blocks every phase gate (`22-development-plan.md`, section 5).

Rules:

1. A feature is not done until its rows here have a passing test. A row without a test is listed as `TODO` with the issue that owns it.
2. The tenant-visible outcome is always one of the error codes in `docs/contracts/errors.md`; never a stack trace, a file path, a hostname of ours, or a secret.
3. A failure of one tenant must never change the outcome for another tenant. Every row in sections 1–4 is also a noisy-neighbour test.
4. Detection must be automatic. "An operator notices" is not a detection mechanism.

Columns: **Failure** · **Detected by** · **Tenant sees** · **Platform does** · **Proof** (test or benchmark) · **Phase**.

## 1. Tenant code misbehaves (runtime)

| Failure | Detected by | Tenant sees | Platform does | Proof | Phase |
| --- | --- | --- | --- | --- | --- |
| Infinite loop / CPU over limit | CPU watchdog | 503 `RENOX_CPU_LIMIT`, logged with route and cpu_ms | `TerminateExecution`, isolate poisoned and replaced, meter `status=cpu_limit` | `renox-runtime` limits test; B12 | F1 |
| Unbounded allocation | V8 near-heap-limit callback | 503 `RENOX_OOM` | Terminate, dispose isolate on its own thread, RSS returns to baseline | limits test (RSS delta ≤ 10 MB after) | F1 |
| Handler never resolves | Wall-clock deadline | 504 `RENOX_DEADLINE` | Cancel pending ops via token, meter `status=timeout` | limits test | F1 |
| Handler throws | Dispatch wrapper | 500 `RENOX_INTERNAL`, request id | Error with stack to tenant log sink only | dispatch test (body has no message/stack) | F1 |
| Route module fails to evaluate on first use | Module loader at the route's first request (`ops.md` 1.4.0 §11 steps 4–5: lazy route modules) | 500 `RENOX_MODULE_EVAL` for that route only; other routes answer | Error logged once per isolate with the module id; the failure is cached until the isolate is replaced; the isolate stays up. A missing export is refused earlier, by `renox check` and at prepare (`artifact.md` V23) | `crates/renox-runtime/tests/lazy_routes.rs` (#265) | F2 |
| Watchdog fires while a DB transaction is open | Runtime op registry | Same as CPU limit | Rollback every open transaction of that request before the isolate is dropped; writer connection released | `crates/renox-runtime/tests/termination.rs`: `cpu_limit_inside_a_transaction_rolls_back_and_releases_the_writer`, `oom_inside_a_transaction_rolls_back_and_releases_the_writer`, `deadline_inside_a_transaction_rolls_back_and_releases_the_writer`, `pending_fetch_is_aborted_when_the_request_is_terminated` (#89) | F1 |
| Too many concurrent requests | Semaphore per deployment | 503 `RENOX_BUSY` + `Retry-After` | Queue up to the deadline, then reject | limits test | F1 |
| Handler writes to global scope | `renox check` lint, dev warning | Lint error / dev overlay warning | Nothing at runtime (documented risk) | lint fixture | F2 |
| Template nested loops / huge output | Render fuel, output size limit | 500 `RENOX_RENDER_LIMIT` with template name and line | Render aborted; render time charged to tenant | B13; renderer limit tests | F2 |
| `fetch` to blocked destination | `net_policy` | `RenoxError RENOX_FETCH_BLOCKED {host, reason}` thrown in tenant code | Request never leaves the node; counter in meter | fetch tests (metadata, loopback, private, redirect hop, v4-mapped v6) | F1 |
| `fetch` response too large / too slow | Egress counter, deadline | `RENOX_FETCH_EGRESS_LIMIT` / `RENOX_DEADLINE` | Abort stream | fetch tests | F1 |
| Secret printed or thrown | Log redaction | `[redacted]` in own logs | Redaction on every log and error path | ops test | F1 |
| SQL touching another module's table | SQLite authorizer at prepare | `RENOX_DB_AUTH {table}` | Statement refused; no partial execution | authorizer tests (JOIN, CTE, ATTACH, PRAGMA, trigger) | F1 |
| Runaway query | `progress_handler` | `RENOX_DB_TIMEOUT` | Statement interrupted, transaction rolled back | limits test (`WITH RECURSIVE`) | F1 |
| Database file over quota | `max_page_count` | `RENOX_DB_QUOTA` | Writes fail, reads continue; dashboard warning | quota test | F1 |
| Unparameterised SQL | `renox check` lint | Lint error | Rejected before deploy | lint fixture | F1 |

## 2. Bad input at the edge (gateway)

| Failure | Detected by | Tenant sees | Platform does | Proof | Phase |
| --- | --- | --- | --- | --- | --- |
| Unknown `Host` | Route table miss | — (end user gets 404) | No cell touched | gateway test | F1 |
| Malformed `Host`, header too large, too many headers | hyper limits (configured) | 400 / 431 | Connection closed, no cell touched | `renox-gateway` `tests/limits.rs`: `header_over_16kb_is_431`, `two_hundred_headers_is_431`; `tests/gateway.rs`: `malformed_or_missing_host_is_400` | F1 |
| Request body over limit | Body limit per route kind (default 1 MB, uploads via storage module) | 413 `RENOX_BODY_TOO_LARGE` | Stream aborted before reaching the isolate | `renox-gateway` `tests/limits.rs`: `two_mb_body_is_413_and_never_dispatched`, `chunked_body_is_cut_at_the_limit` | F1 |
| Slowloris / idle connections | Header read timeout, idle timeout, max connections per IP | — | Connection dropped | `renox-gateway` `tests/limits.rs`: `one_byte_per_second_is_closed_at_the_header_timeout`, `idle_connection_is_closed_at_the_idle_timeout`, `connection_101_from_one_ip_is_rejected` | F1 |
| Request flood from one IP | Token bucket | 429 + `Retry-After` | Not metered to tenant | gateway test | F1 |
| Flood from many IPs on one tenant | Per-tenant concurrency and tier CPU quota | 503 `RENOX_BUSY` | Other tenants unaffected (B12) | B12 | F1 |
| Flood on login/register/reset | Stricter route buckets | 429 | — | security tests | F2 |
| CSRF token missing or wrong | Action dispatcher | 403 `RENOX_CSRF` | Action not run | pages test | F2 |
| Cross-origin request without CORS allow | Gateway CORS | 403 / no CORS headers | — | security tests | F2 |
| Unverified custom domain | Domain state | 404 | Never served before TXT verification | domains test | F3 |
| Browser error (script, island, Alpine) or htmx failure (error response, no target, swap error, timeout) | `renox-client.js` events with request id | Dev: overlay "Browser" tab; prod: dashboard group with original file and line | Event rate-limited and logged with `source=client`; nothing touches the isolate | #127 Playwright suite; #128 grouping tests | F2/F3 |
| Script blocked by CSP | CSP `report-to` → `/__renox/events` | Dev overlay / dashboard `csp.violation` with directive and source | Same as above | #126 normalisation test | F2 |
| Client-event flood (bug or abuse) | Per-IP and per-tenant buckets at the gateway | Nothing (204 always) | Dropped and counted; daily quota warning in the dashboard | #126 limit tests; #128 quota test | F2/F3 |
| WebSocket message flood / oversized frame | Per-connection limits, backpressure | Connection closed with code | Fan-out never touches the isolate | realtime tests, B14 | F5 |

## 3. Deploy and artifact failures (CLI, control plane, worker)

| Failure | Detected by | Tenant sees | Platform does | Proof | Phase |
| --- | --- | --- | --- | --- | --- |
| Syntax error, missing `renox.toml`, bad route file name | `renox build` / `renox check` | CLI error with file and line, non-zero exit | Nothing uploaded | `TODO` → #90 | F2 |
| Watcher thrash (many saves per second) | `renox dev` debounce | One rebuild per burst | Isolate recreated once | same issue | F2 |
| Artifact hash mismatch, symlink, `..` path | Worker artifact loader | Deploy rejected | Artifact refused, never loaded | artifact tests | F1 |
| Bundle over 20 MB, route conflict, unknown permission key | CLI check and control-plane validation (same code) | Structured validation error | Deployment state `rejected` | validation tests | F3 |
| Tarball decompression bomb / too many files | Validation with size and entry caps before extraction | Rejected | Extraction aborted at cap | `TODO` → #95 | F3 |
| Upload interrupted, retried | Content hash idempotency | Same hash, same deployment | No duplicate | deployments test | F3 |
| Migration fails half-way during activation | Migration runner (transaction per file) | Deployment stays `validated` with the failing file and SQL error; old deployment keeps serving | No route switch; `renox__migrations` unchanged for the failed file | `TODO` → #96 | F3 |
| New deployment fails its first request | Activation health probe | Activation reported failed; old stays active | Automatic pointer revert | same issue | F3 |
| Rollback to a hash whose migrations are older than the schema | Expand/contract rule (D17) | Rollback allowed; code must tolerate newer columns | Documented contract; `renox check --target <hash>` warns | same issue | F3 |
| Route update message lost or out of order | Version number per route entry; periodic full resync | Nothing (converges) | Worker applies only newer versions, resyncs every N s | `TODO` → #97 | F3 |
| Control plane unreachable from the worker | Heartbeat failure | Nothing for existing cells | Worker keeps serving from the local route table and artifact cache; meters buffered to disk; new cold starts for uncached artifacts fail with 503 `RENOX_UNAVAILABLE` | `TODO` → #98 | F3 |
| Object storage unreachable | Artifact fetch error | Cold start fails 503 for uncached artifacts only | Retry with backoff; alert | same issue | F3 |

## 4. Data and node failures

| Failure | Detected by | Tenant sees | Platform does | Proof | Phase |
| --- | --- | --- | --- | --- | --- |
| Isolate evicted while a request arrives | Cell state machine | Nothing (slightly slower) | Request waits for the fresh cell | cell test | F1 |
| Deployment switch while requests in flight | Draining state | Nothing | Old cell finishes in-flight, then evicted | cell test | F1 |
| SQLite file corrupted, WAL unreadable | `PRAGMA quick_check` on open; SQLite error codes | 503 `RENOX_DB_UNAVAILABLE` until restored | Cell marked unhealthy; restore from Litestream; alert | `TODO` → #103 | F6 |
| Disk full on node | Write errors, disk watermark | Writes fail `RENOX_DB_QUOTA`-like code | Node marked not schedulable; outbox and log pruning; alert | same issue | F6 |
| Outbox or logs grow unbounded | Size watermarks | Nothing | Pruning, dead-letter cap, per-tenant log volume limit | same issue | F4/F6 |
| Node dies | Control-plane heartbeat | Downtime ≤ RTO of the tier | Tenants reassigned; restore from replica or S3 | B18 | F6 |
| Replica lagging / Litestream behind | Replication lag metric | Nothing until failover | Alert; failover prefers the freshest copy | B18/B19 | F6 |
| Meter batch cannot be shipped | Sink retry exhausted | Nothing | Dead-letter file on disk, replayed later; billing never silently loses data | meter tests; ingestion dedup test | F1/F3 |
| Clock skew between gateway and worker | Single deadline set at the gateway, propagated as remaining ms | Nothing | Deadlines are durations, not timestamps | design rule (`03-architecture.md`) | F1 |

## 5. Modules and authorization

| Failure | Detected by | Tenant sees | Platform does | Proof | Phase |
| --- | --- | --- | --- | --- | --- |
| Module service throws | Broker | `RenoxError` in caller with module and service name | Transaction rolled back if inside one | broker tests | F4 |
| Event handler fails repeatedly | Outbox retries | Dead-letter visible in `jobs` module | N retries with backoff, then dead-letter | outbox tests | F4 |
| Module contract broken on upgrade (missing service, view version) | `renox check` | Upgrade refused with the broken reference | No migration run | check tests | F4 |
| Template override drifted from module version | Stored original hash | Warning with diff | Upgrade continues, override flagged | override tests | F4 |
| Policy denies | Cedar | 403 `RENOX_FORBIDDEN` with policy id in dev | Audit row for sensitive actions | policy tests per role | F5 |
| Unscoped query on an owned table | `db.scoped` enforcement for module code | `RENOX_DB_SCOPE` | Statement refused | scoped tests | F5 |
| Session fixation, replayed token, OAuth `state` mismatch, password reset token reuse | `auth` module | Login refused | Session rotated on login; tokens single-use; `state` checked | `TODO` → #100 | F4 |
| Marketplace module unsigned or permission diff on upgrade | Registry verification | Install refused / approval required | Hash can be disabled globally | registry tests | F7 |

## 6. Verification practice

- Every phase has a `negative path checklist` issue listing the rows of this document due in that phase; the gate review is blocked by it: F1 #92, F2 #94, F3 #99, F4 #101, F5 #102, F6 #105, F7 #106.
- From F6 a fault-injection harness (`bench/chaos/`, #104) runs the node, storage, and control-plane failures above on a schedule against the examples, and B18 is one of its scenarios.
- Error codes shown to tenants are catalogued in `docs/contracts/errors.md` (#91) with: HTTP status, when it happens, what the tenant should do, what is logged.
- Security threats (attacks rather than failures) are catalogued separately in `docs/24-threat-model.md`, with their own per-phase `security checklist` issue blocking the same gate reviews.
