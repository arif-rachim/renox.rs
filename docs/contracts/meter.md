# Contract: meter records

| | |
| --- | --- |
| Version | **0** (F1). Written into every batch as `schema_version` |
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

All fields are required. Integers are JSON numbers within ±(2^53 − 1). `f64` fields are non-negative JSON numbers, rounded to 3 decimal places (microsecond resolution).

| Field | Type | Unit | Source | Meaning |
| --- | --- | --- | --- | --- |
| `request_id` | string, `^[0-9A-Za-z_-]{8,64}$` | — | gateway | The id the gateway assigned (`x-renox-request-id`, `ops.md` section 6): a ULID, unique across the platform. The de-duplication key (section 4) |
| `tenant_id` | string, `^[a-z0-9][a-z0-9_-]{0,62}$` | — | cell, from the route table | Same value as `artifact.md` section 5. Never taken from request input |
| `deployment_hash` | string, 64 lower-case hex | — | cell, from the route table | The artifact hash (`artifact.md` section 2) |
| `route` | string, `<METHOD> <pattern>` | — | cell, from the matched manifest route | Method plus the route pattern from `manifest.routes[]`, e.g. `GET /api/notes/:id`. Low cardinality by construction |
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
| `render_fuel` | integer | fuel units | runtime | Template render fuel. Always `0` in F1; filled from F2 (`docs/08-template-engine.md`) |
| `logs_dropped` | integer | lines | runtime, `op_log` | Log lines dropped by the tenant log rate limit during this request (`ops.md` section 4) |
| `http_status` | integer, 100–599 | — | cell | Status code sent to the client. For an invocation ended by client disconnect, the status that was sent or would have been sent |
| `status` | enum (below) | — | cell | How the invocation ended, from the platform's point of view |

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
| Realtime | F5 | `kind: "realtime"`, `tenant_id`, `deployment_hash`, `period_start`, `period_end`, `connection_seconds`, `peak_connections`, `messages_in`, `messages_out`, `bytes_out` | Per cell per minute |
| Storage | F5 (SQLite), F7 (object storage) | `kind: "storage"`, `tenant_id`, `measured_at`, `sqlite_bytes`, `wal_bytes`, `object_bytes`, `object_count` | Hourly, end of hour (`docs/05-tenant-lifecycle.md`) |
| Render | F2 | No new record; `render_fuel` and render time move into the invocation record | — |
| Background jobs and events | F4/F6 | Invocation records with a `route` of the form `JOB <name>` / `EVENT <name>` | Per run |

## 7. Mapping to billing dimensions

`docs/01-business.md` prices pay-per-use on **requests + CPU-ms + egress + storage**, following these meters:

| Billing dimension | Derived from | Notes |
| --- | --- | --- |
| Requests | Count of records with `status` ≠ `busy` | `busy` rejections are not charged |
| CPU-ms | Sum of `cpu_ms` | `render_fuel` converted to CPU-ms from F2 (rendering runs outside the tenant's CPU limit but is charged to its quota, `docs/04-isolation-security.md`) |
| Egress | Sum of `egress_bytes + fetch_sent_bytes` | Bytes leaving our network. `fetch_received_bytes` and `ingress_bytes` are kept for abuse detection and limits, not billed |
| Storage | Storage meter (reserved, section 6) | Not derived from invocation records |
| Not billed, kept for limits and dashboards | `wall_ms`, `peak_heap_bytes`, `db_ms`, `db_rows`, `fetch_blocked`, `logs_dropped`, `http_status` | Tier enforcement, usage views, anomaly alerts (`docs/24-threat-model.md`, abuse rows) |

## Open

1. **Retry and buffer numbers** (1–60 s backoff, 10,000 buffered records) are proposals for #24.
2. **CPU attribution under concurrency.** `cpu_ms` sums the slices that run on behalf of the request (`ops.md` section 10). Microtasks scheduled by one request and run during another are attributed through the request's async context. If #25 shows that attribution is unreliable on the pinned runtime, the fallback in `ops.md` section 10 (one in-flight request per isolate) makes it exact.
3. **Crash window.** Up to 5 s of records can be lost on a node crash (section 4). Acceptable for F1 because nothing is billed before F3; revisit with the F3 ingestion issue.
4. **Cold-start cost.** Module evaluation at isolate start (`ops.md` section 11) is not charged to any request in v0. Whether to expose it as a field (`cold_start_ms`) for dashboards is open; adding it is a minor change.
