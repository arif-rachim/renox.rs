# Contract: meter records

| | |
| --- | --- |
| Version | **0.4** (F7, #318: the `kind` value `image` with the route form `IMG <width>w <format>`, the fields `storage_bytes`, `image_variants`, `ai_tokens_in`, `ai_tokens_out`, `render_pdf_ms`; for `ops.md` 1.7.0). 0.3 (F5, #272: `kind` values `tool` and `job`, the `authz_evals`, `realtime_conn_seconds` and `realtime_messages` fields, the route forms `WS`, `SSE`, `TOOL` and `JOB`, the `status` value `forbidden`; for `ops.md` 1.5.0). 0.2 (#226) added event delivery records. Batches carry `schema_version: 0`: 0.1 to 0.3 are additive, and every version 0 record is a valid 0.3 record (section 8). History: "Changelog" at the bottom |
| Producers | `crates/renox-meter` (P4), fed by `crates/renox-runtime` (P1) and `crates/renox-cell` (P5) |
| Consumers | `control/billing` (P14, F3): aggregation into billing tables; dashboard usage views (P13, F3); abuse detection (`docs/24-threat-model.md`) |
| Machine-readable | [`schemas/meter-record.schema.json`](schemas/meter-record.schema.json): the batch envelope (root) and the record (`$defs/record`) |
| Examples | [`examples/meter-batch.json`](examples/meter-batch.json) (valid); invalid examples under [`examples/meter/`](examples/meter/) |
| Checker | `bun run docs/contracts/validate.ts` |
| Sources | `docs/05-tenant-lifecycle.md` ("Metering and billing"), `docs/04-isolation-security.md` ("All limits are measured per request"), `docs/01-business.md` (pay-per-use dimensions), `ops.md` section 7 |

Every invocation of tenant code produces exactly one meter record. Records are the only input to billing and to the tenant's usage views. They are batched per cell and delivered at least once. This contract fixes the record, the batch, delivery semantics, and the F1 sink. How records are aggregated into invoices is F3 (P14) and out of scope.

## 1. When a record is written

- **One record per invocation**: a request that reached a deployment's route and was admitted to, or rejected by, the cell's per-deployment concurrency limit. The record is written when the invocation ends for any reason: response complete, handler error, deadline, CPU or memory limit, or client disconnect.
- **No record** for requests that never reach a cell: unknown host, gateway rate limit (429), request body over the limit (413 `RENOX_BODY_TOO_LARGE`), malformed requests. The same holds for 404 and 405 answers from route matching, where no tenant code runs. These are counted by gateway metrics and are not billed (`docs/23-failure-modes.md`, "Request flood from one IP": "Not metered to tenant").
- A record never contains request or response content, header values, query strings, user identifiers, or secrets. `route` is the pattern, never the concrete URL.

## 2. Record fields

All fields are required except `render_ms`. Integers are JSON numbers within ±(2^53 − 1). `f64` fields are non-negative JSON numbers, rounded to 3 decimal places (microsecond resolution).

| Field | Type | Unit | Source | Meaning |
| --- | --- | --- | --- | --- |
| `request_id` | string, `^[0-9A-Za-z_-]{8,64}$` | — | gateway | The id the gateway assigned (`x-renox-request-id`, `ops.md` section 6): a ULID, unique across the platform. The de-duplication key (section 4) |
| `tenant_id` | string, `^[a-z0-9][a-z0-9_-]{0,62}$` | — | cell, from the route table | Same value as `artifact.md` section 5. Never taken from request input |
| `deployment_hash` | string, 64 lower-case hex | — | cell, from the route table | The artifact hash (`artifact.md` section 2) |
| `route` | string, `<METHOD> <pattern>` | — | cell, from the matched manifest route | Method plus the route pattern from `manifest.routes[]`, e.g. `GET /api/notes/:id`. Low cardinality by construction. From 0.3 also `WS <pattern>` and `SSE <pattern>` for a realtime connection, `TOOL <name>` for a tool call, `JOB <module> <name>` for a job attempt ("Realtime, tool, and job records", below). From 0.4 `IMG <width>w <format>` for an image variant; a `webhook` route (`artifact.md` 1.4) is an ordinary request record, `POST <pattern>` with `kind` absent, and a duplicate delivery (`ops.md` section 22) is a request record too |
| `started_at` | integer | Unix time, ms | cell | When the cell admitted the request (or rejected it as busy). Cell clock; only used to bucket records into hours |
| `cpu_ms` | f64 | CPU milliseconds | runtime: **thread CPU time** (`CLOCK_THREAD_CPUTIME_ID`) of the isolate thread, summed over every slice of JavaScript and synchronous op work run on behalf of this request (`ops.md` section 10). Not V8's own counters, and not the Edge Runtime's per-worker CPU timer, which is cumulative per worker | The number that the CPU limit is checked against. Work on other threads (DNS, TLS, SQLite on a blocking pool) is not included; it is accounted as `db_ms` or as wall time |
| `wall_ms` | f64 | milliseconds | cell, monotonic clock | From admission until the last response byte was handed to the gateway, or until the invocation ended by a limit or disconnect. For `busy`: time spent waiting in the queue |
| `peak_heap_bytes` | integer | bytes | runtime: V8 `used_heap_size` high-water mark of the isolate, sampled at each slice end and in the near-heap-limit callback | Peak of the **isolate** while this request was in flight. With concurrent requests on one isolate it is shared, not attributable to one request |
| `ingress_bytes` | integer | bytes | cell | Request body bytes received from the client (headers excluded) |
| `egress_bytes` | integer | bytes | cell | Response body bytes sent to the client (headers excluded) |
| `fetch_sent_bytes` | integer | bytes | runtime, `op_fetch` | Bytes sent by outbound `fetch` (request line, headers, body), over all hops |
| `fetch_received_bytes` | integer | bytes | runtime, `op_fetch` | Bytes received by outbound `fetch` (status line, headers, body), over all hops. `fetch_sent_bytes + fetch_received_bytes` is the counter checked against the per-request egress limit (`ops.md` section 2) |
| `fetch_blocked` | integer | count | runtime, `op_fetch` | Outbound requests rejected with `RENOX_FETCH_BLOCKED`, whether or not tenant code caught the error |
| `db_ms` | f64 | milliseconds | runtime, `op_db_*` | Wall time spent in database ops, including waits for the write lock |
| `db_rows` | integer | rows | runtime, `op_db_*` | Rows returned by queries plus rows changed by statements (`changes`) |
| `render_fuel` | integer | fuel units | cell, from `renox-template` | Template render fuel used by every render of this invocation (the page or fragment, out-of-band fragments, and an error page). `0` when nothing was rendered, and in F1 (`docs/08-template-engine.md`) |
| `render_ms` | f64, **optional** (0.1) | CPU milliseconds | cell: **thread CPU time** (`CLOCK_THREAD_CPUTIME_ID`) of the render-pool thread while it rendered for this invocation | Rendering runs off the isolate thread, outside the tenant's CPU limit, so it is **not** in `cpu_ms`. Absent means `0`: version 0 producers omit it, and so may a producer for an invocation that rendered nothing |
| `logs_dropped` | integer | lines | runtime, `op_log` | Log lines dropped by the tenant log rate limit during this request (`ops.md` section 4) |
| `http_status` | integer, 100–599 | — | cell | Status code sent to the client. For an invocation ended by client disconnect, the status that was sent or would have been sent |
| `status` | enum (below) | — | cell | How the invocation ended, from the platform's point of view |
| `kind` | `"request"`, `"event"`, (0.3) `"tool"`, `"job"`, or (0.4) `"image"`, **optional** (0.2) | — | cell | What was invoked. Absent means `"request"`. `"event"`: one delivery attempt of a durable event ("Event records", below); `"tool"`: one `tools/call` through `/mcp`; `"job"`: one attempt of a scheduled or queued job ("Realtime, tool, and job records", below) |
| `authz_evals` | integer, **optional** (0.3) | count | cell, `crates/renox-authz` | Cedar evaluations of the invocation: the route `guard`, `op_authz_*`, `r-can` with a resource (cache hits excluded), the subscribe check, the tool check (`ops.md` section 17, "Metering and limits"). Absent means `0` |
| `realtime_conn_seconds` | f64, **optional** (0.3) | seconds | cell, `crates/renox-realtime` | The lifetime of a `ws` or `sse` connection, on its record only (`route` `WS …` / `SSE …`). Absent means `0` |
| `realtime_messages` | integer, **optional** (0.3) | count | cell, `crates/renox-realtime` | Frames received on the connection plus messages delivered to it (`send`, `publish`, feeds, replay), on a connection record only. Absent means `0` |
| `storage_bytes` | integer, **optional** (0.4) | bytes | cell, `ops.md` §21 | The tenant's stored bytes at the end of an invocation that put or deleted a file, and on every `image` record. Absent when nothing was stored |
| `image_variants` | integer, **optional** (0.4) | count | cell, `ops.md` §21 | Image variants created by the invocation; on an `image` record, 1. Absent when none |
| `ai_tokens_in` | integer, **optional** (0.4) | tokens | runtime, `ops.md` §23 | Input tokens of the invocation's `ai.chat` calls (direct and gateway). Absent when none |
| `ai_tokens_out` | integer, **optional** (0.4) | tokens | runtime, `ops.md` §23 | Output tokens of the same calls |
| `render_pdf_ms` | f64, **optional** (0.4) | ms | runtime, `ops.md` §24 | Time of the HTML-to-PDF conversions, outside `cpu_ms` like `render_ms`. Absent when none |

### Event records (0.2)

Each delivery attempt of a durable event to one module's handler (`ops.md` section 15.4) is one invocation and one record, with `kind: "event"`. The fields keep their meaning, with these values:

| Field | Value for an event record |
| --- | --- |
| `request_id` | `<event id>_<module>_<attempt>`: unique per attempt, so de-duplication (section 4) never merges two attempts |
| `route` | `EVENT <module> <event name>`, e.g. `EVENT email billing.invoice_paid`: the handling module and the event; low cardinality like a route pattern |
| `ingress_bytes`, `egress_bytes` | `0`: there is no client |
| `http_status` | `200` when `status` is `ok`, `500` otherwise; there is no client response, the field stays required for older consumers |
| `status` | `ok` (the handler resolved), `error` (it threw), `timeout`, `cpu_limit`, or `oom`; never `busy`, `blocked_fetch` (an uncaught blocked fetch is `error`), or `render_limit` |

A request record (`kind` absent or `"request"`) never has an `EVENT` route, and an event record never has a `<METHOD>` route (`schemas/meter-record.schema.json`, the record's `if`/`then`/`else`). Service calls, hooks, and in-memory event handlers run inside the request that made them and produce no record of their own (`ops.md` section 7).

### Realtime, tool, and job records (0.3)

| Record | `kind` | `route` | `request_id` | Fields with a special value |
| --- | --- | --- | --- | --- |
| A `ws` or `sse` connection (`ops.md` section 18): **one invocation from the upgrade to the close**, written at the close | `request` (absent) | `WS <pattern>` / `SSE <pattern>` | the upgrade request's id | `http_status` 101 (ws) or 200 (sse); `wall_ms` the lifetime; `cpu_ms`, `db_*`, `fetch_*`, `render_*` summed over the `open`, `message`, `close` runs and the fragment renders they published; `realtime_conn_seconds` and `realtime_messages` set; `status` `ok` for any close (either side, or a platform limit close), `error` when `open` threw, `busy` for an upgrade refused by the connection caps (no tenant code ran), `forbidden` for a denied `guard` |
| A tool call through `/mcp` that reached `run` (`ops.md` section 19) | `tool` | `TOOL <name>` | the HTTP request's id | `http_status` 200; `status` `ok`, `error` (`run` threw, or its output was over 256 KB), or the kill statuses; a preview run is a record too; `ingress_bytes` and `egress_bytes` are the HTTP request's and response's |
| A job attempt (`ops.md` section 20): a scheduled tick or a queued run, one record per attempt like an event delivery | `job` | `JOB <module> <name>` (`JOB app nightly-report`) | `<outbox row id>_<attempt>` | `ingress_bytes`, `egress_bytes` 0; `http_status` 200 when `status` is `ok`, 500 otherwise; `status` as for an event record |

A `tool` record's route starts with `TOOL `, a `job` record's with `JOB `, and neither carries the realtime fields; an `event` record never does either (the schema's per-kind rules). A `guard` denial on any route writes a request record with `status: forbidden` and the usual `<METHOD> <pattern>` route.

### `status`

| Value | Meaning | Typical `http_status` |
| --- | --- | --- |
| `ok` | The handler returned a `Response` and it was sent. A tenant-chosen 4xx/5xx is still `ok` | any |
| `error` | The handler threw or returned a non-`Response`; the client got `RENOX_INTERNAL` | 500 |
| `timeout` | The wall-clock deadline passed (`RENOX_DEADLINE`) | 504 |
| `cpu_limit` | The CPU watchdog terminated the isolate (`RENOX_CPU_LIMIT`), including the other in-flight requests of that isolate (`ops.md` section 10) | 503 |
| `oom` | The isolate hit its heap limit (`RENOX_OOM`) | 503 |
| `blocked_fetch` | The handler failed with an **uncaught** `RENOX_FETCH_BLOCKED`. A blocked fetch that tenant code caught is `ok` with `fetch_blocked > 0` | 500 |
| `busy` | Rejected by the per-deployment concurrency limit after queueing (`RENOX_BUSY`); no tenant code ran, so `cpu_ms`, `db_*`, `fetch_*` are 0 | 503 |
| `render_limit` | Rendering the page or a fragment ran out of fuel, iterations, output size, include depth, or render time (`RENOX_RENDER_LIMIT`, F2). `render_fuel` and `render_ms` hold what was used up to the stop | 500 |
| `forbidden` (0.3) | The route's `guard` denied before the handler, or the tool check denied before `run` (403 `RENOX_FORBIDDEN`, `ops.md` section 17). The principal was resolved, so tenant code may have run (the `auth.principal` service); `authz_evals` ≥ 1. An uncaught `ForbiddenError` from a handler is `ok` with the handler's 403, not `forbidden` | 403 |

`busy` is an addition to the list in issue #16 (it was proposed in `ops.md` section 7). The record is kept because dashboards need to show rejected load, but billing does not charge it (section 5).

## 3. Batch envelope

```json
{
  "schema_version": 0,
  "cell_id": "t_hello@node-dxb-01",
  "node_id": "node-dxb-01",
  "records": [ { "request_id": "01JBQ3Z7M8K5V6W9X2Y4A1B3C5", "...": "..." } ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | integer, `0` | This contract's version. A consumer rejects a batch with a version it does not know (and keeps it for replay) |
| `cell_id` | string, `^[a-z0-9][a-z0-9_.@-]{0,127}$` | The cell that produced the records |
| `node_id` | string, `^[a-z0-9][a-z0-9_.-]{0,62}$` | The worker node |
| `records` | array, 1–1,000 records | Records in the order their invocations ended |

Batching rules:

- A cell flushes its buffer when it holds **1,000 records or 5 s after the first buffered record**, whichever comes first, and also on clean shutdown or eviction of the cell.
- An empty batch is never written.
- A batch is the unit of delivery: it is written or sent whole, or not at all.

## 4. Delivery semantics

- **At least once.** A batch may be delivered more than once (retry after a timeout, replay of the dead-letter file). Consumers de-duplicate on `request_id`: a second record with a `request_id` already seen is dropped, whatever batch it arrives in. `request_id` is unique per invocation, so de-duplication never merges two real invocations.
- **Never silently lost.** If the sink fails, the meter retries with exponential backoff (1 s doubling to 60 s *proposed*) while buffering in memory up to 10,000 records *proposed*. Beyond that, or on shutdown, batches go to a dead-letter file on local disk that is replayed when the sink recovers (`docs/23-failure-modes.md`, "Meter batch cannot be shipped"). Shedding records to protect the node is not allowed; if the disk is full, the node is marked unschedulable instead (#103).
- **Order is not guaranteed** across batches or cells. Consumers bucket by `started_at` and do not assume arrival order.
- A record is written after the response is complete, so a crash of the node between the response and the flush can lose the records of that window. This window is bounded by the 5 s flush interval and is an accepted loss in F1; F6 (#103) revisits it with a write-ahead file if billing volume warrants.

## 5. Sinks

| Sink | Phase | Format |
| --- | --- | --- |
| **File** | F1 (default) | Newline-delimited JSON, one batch envelope per line, appended to `<data_dir>/meters/<cell_id>/<YYYY-MM-DD>.ndjson` (UTC date of the write). Each append is followed by `fsync`. Files are never rewritten; rotation is by date. Dead letters go to `<data_dir>/meters/<cell_id>/dead/` with the same format |
| **Stdout** | F1, `renox dev` | The same envelope line on standard output, for local inspection. Not durable |
| **HTTP** | reserved, F3 | `POST` of one batch envelope to the control plane's meter ingestion endpoint, authenticated with the node's credentials; 2xx = accepted (de-duplicated server-side). Defined by the F3 ingestion issue |

The sink interface in `renox-meter` is one method that takes a batch and either persists it entirely or fails: `fn write(&self, batch: &Batch) -> Result<(), SinkError>`. Retries and the dead-letter file sit in front of every sink, so no sink needs its own.

## 6. Reserved meters

Not produced in v0. They get their own record kind in a later version. A record without `kind` is an invocation record, so adding `kind` later is a minor change.

| Meter | Phase | Field sketch | Interval |
| --- | --- | --- | --- |
| Realtime | F5 (done in 0.3) | No per-minute record: a connection is one invocation record with `realtime_conn_seconds` and `realtime_messages` (section 2, "Realtime, tool, and job records"). A per-cell `peak_connections` gauge is a metric of the control endpoint (#295), not a meter record | — |
| Storage | F5 (SQLite), F7 (object storage) | `kind: "storage"`, `tenant_id`, `measured_at`, `sqlite_bytes`, `wal_bytes`, `object_bytes`, `object_count` | Hourly, end of hour (`docs/05-tenant-lifecycle.md`) |
| Render | F2 (done in 0.1) | No new record: `render_fuel` and `render_ms` are fields of the invocation record (section 2) | — |
| Background jobs | F6 (done in 0.3) | Invocation records with `kind: "job"` and `route` `JOB <module> <name>` (section 2); produced from #297 | Per attempt |
| App MCP tools | F5 (done in 0.3) | Invocation records with `kind: "tool"` and `route` `TOOL <name>` (section 2); produced from #285 | Per call |

## 7. Mapping to billing dimensions

`docs/01-business.md` prices pay-per-use on **requests + CPU-ms + egress + storage**, following these meters:

| Billing dimension | Derived from | Notes |
| --- | --- | --- |
| Requests | Count of records with `status` ≠ `busy` | `busy` rejections are not charged. Event records (0.2), tool and job records (0.3) count as requests: each runs tenant code. A connection record counts as one request, whatever its length (the length is billed as realtime) |
| CPU-ms | Sum of `cpu_ms + render_ms` (absent `render_ms` = 0) | Rendering runs outside the tenant's CPU limit but is charged to its quota (`docs/04-isolation-security.md`), so it is billed as the CPU time it took. `render_fuel` is not converted: it is kept for the render limits and dashboards |
| Egress | Sum of `egress_bytes + fetch_sent_bytes` | Bytes leaving our network. `fetch_received_bytes` and `ingress_bytes` are kept for abuse detection and limits, not billed |
| Realtime (0.3) | Sum of `realtime_conn_seconds` and sum of `realtime_messages` | `docs/09-htmx-realtime.md`: "metered per tenant (connection-seconds and messages) for billing". The price per dimension is F7 (`control/billing`); until then both are usage-view numbers (#296) |
| Storage | The latest `storage_bytes` of the tenant in the period (0.4), and the storage meter (reserved, section 6) for the tenant file | Image variants are stored bytes too |
| AI (0.4) | Sum of `ai_tokens_in` and of `ai_tokens_out` of gateway calls | Direct calls use the tenant's own key and are not billed; they are kept for the quota and dashboards |
| Not billed, kept for limits and dashboards | `wall_ms`, `peak_heap_bytes`, `db_ms`, `db_rows`, `fetch_blocked`, `logs_dropped`, `render_fuel`, `http_status`, `authz_evals` (0.3: the evaluation quota of `ops.md` section 17, not a price) | Tier enforcement, usage views, anomaly alerts (`docs/24-threat-model.md`, abuse rows) |

## 8. Versioning

- The contract version is `MAJOR.MINOR`. Batches carry only the major as `schema_version`, because a minor change never makes an old record invalid or changes the meaning of an existing field.
- **Minor**: a new optional field (absent = a stated default), a new `status` value, a field whose allowed range widens. Consumers built for the new minor accept records of every older minor of the same major. A consumer built for an older minor may meet an unknown optional field or `status`: it keeps the batch for replay instead of dropping it, as for an unknown `schema_version`.
- **Major**: a removed or renamed field, a changed unit or meaning, a new required field. It bumps `schema_version`.
- Contract edits are made only by `type:contract` issues.

## Open

1. **Retry and buffer numbers** (1–60 s backoff, 10,000 buffered records) are proposals for #24.
2. **CPU attribution under concurrency.** `cpu_ms` sums the slices that run on behalf of the request (`ops.md` section 10). Microtasks scheduled by one request and run during another are attributed through the request's async context. If #25 shows that attribution is unreliable on the pinned runtime, the fallback in `ops.md` section 10 (one in-flight request per isolate) makes it exact.
3. **Crash window.** Up to 5 s of records can be lost on a node crash (section 4). Acceptable for F1 because nothing is billed before F3; revisit with the F3 ingestion issue.
4. **Cold-start cost.** Module evaluation at isolate start (`ops.md` section 11) is not charged to any request in v0. Whether to expose it as a field (`cold_start_ms`) for dashboards is open; adding it is a minor change.
5. **`render_ms` vs fuel.** Billing uses `render_ms` (section 7). If #38 or the F2 benchmarks show render CPU time is too noisy per request to bill, billing could switch to a fuel-based conversion; that is a change of section 7 only, not of the record.

## Changelog

| Version | Issue | Changes |
| --- | --- | --- |
| 0 | #16 | First version (F1): record, batch, delivery, sinks, reserved meters, billing mapping |
| 0.1 | #152 | `render_fuel` may be non-zero (filled by the cell); new optional `render_ms` (render-pool CPU time, outside `cpu_ms`); new `status` value `render_limit`; billed CPU-ms is `cpu_ms + render_ms`; versioning rules (section 8) |
| 0.2 | #226 | New optional `kind` (`"request"`, `"event"`; absent = request); event delivery records with the `EVENT <module> <name>` route form and the `<event id>_<module>_<attempt>` request id (section 2, "Event records"), the route form checked per `kind` by the schema; event attempts are billed as requests (section 7); `ops.md` 1.3.0 |
| 0.3 | #272 | `kind` values `"tool"` and `"job"` with the route forms `TOOL <name>` and `JOB <module> <name>`; the route forms `WS <pattern>` and `SSE <pattern>` for a realtime connection, which is one record written at the close; new optional fields `authz_evals`, `realtime_conn_seconds`, `realtime_messages` (absent = 0; the realtime fields only on a connection record); new `status` value `forbidden`; the realtime billing dimension (section 7); the reserved realtime and job meters settled (section 6); `ops.md` 1.5.0 |
| 0.4 | #318 | `kind` value `"image"` (one record per image variant created on `/_img`, route `IMG <width>w <format>`, no tenant code: `cpu_ms` 0, the transform is platform time) and the fields `storage_bytes`, `image_variants`, `ai_tokens_in`, `ai_tokens_out`, `render_pdf_ms`; the AI and storage billing rows |
