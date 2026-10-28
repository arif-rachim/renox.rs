# Contract: deploy API

| | |
| --- | --- |
| Version | **0** (F3). HTTP paths are under `/v1`; every worker message carries `schema_version: 0`. Adding an endpoint, an optional request field, or an error row is minor. Removing or renaming a field, a path, or a state, or changing a status code, is breaking: `/v2` and `schema_version: 1` |
| Producers | `control/api` (P12) |
| Consumers | `cli/` (P11): `renox deploy`, `logs`, `secrets`, `domains`, `tokens` (#58, #113); `crates/renox-cell` (P5): the controlled-mode worker (#55, #96, #97, #98, #162); the dashboard (P13, #57); the remote MCP (#62) |
| Machine-readable | [`schemas/deploy-api.yaml`](schemas/deploy-api.yaml) (OpenAPI 3.1, every endpoint with request and response examples); [`schemas/control-messages.schema.json`](schemas/control-messages.schema.json) (JSON Schema 2020-12: worker registration, heartbeat, route table, activation, bundles, log batches); meter batches are [`schemas/meter-record.schema.json`](schemas/meter-record.schema.json) |
| Examples | [`examples/deploy-api/`](examples/deploy-api/): one or more valid and invalid examples per worker message; HTTP bodies have their examples inside the OpenAPI file (`examples` and `x-renox-invalid-examples`) |
| Checker | `bun run docs/contracts/validate.ts` (schemas, examples, rules R1–R3, the state machines below against `x-renox-state-machines`, error codes against `errors.md`) |
| Sources | `docs/05-tenant-lifecycle.md` ("Deploy pipeline", "Lifecycle states", "Custom domains and DNS"), `docs/03-architecture.md` (control plane components), `docs/04-isolation-security.md` ("Secrets", "Operational security"), `docs/06-data.md` (control plane in Postgres), [`artifact.md`](artifact.md), [`meter.md`](meter.md), [`errors.md`](errors.md), `docs/24-threat-model.md` section E |

The deploy API is how a tenant developer's code gets from a laptop or CI into the route table, and how worker nodes learn what to run. It has three kinds of callers, each with its own token: **tenants** (CLI, dashboard, MCP), **nodes** (`renox-worker` in `mode = "controlled"`), and **operators**. The control plane is the source of truth (Postgres) and owns object storage for artifacts; a node never reads Postgres or the artifact bucket's listing.

```
renox deploy ──► POST /v1/apps/{app}/deployments   (tar) ──► validate (V1–V13, T1–T8) ──► artifacts/<hash>.tar
             ──► POST /v1/apps/{app}/activate              ──► prepare ──► owning node: fetch, migrate, create cell, probe
                                                           ◄── prepare_result
                                                           ──► route_delta ──► every node (SSE stream)
node ──► POST /v1/nodes/register, /heartbeat ; GET /v1/nodes/{id}/stream (SSE), /routes (snapshot, ETag)
     ──► POST /v1/ingest/meters, /v1/ingest/logs
```

## 1. Conventions

- **Transport.** HTTPS only in production (TLS 1.2+). The local compose stack (`control/docker-compose.yml`) serves plain HTTP on `localhost:8787`.
- **Bodies.** JSON is UTF-8, `Content-Type: application/json`, at most 1 MiB (413 `RENOX_BODY_TOO_LARGE`), except the upload bodies of section 4. Unknown fields are rejected (400 `RENOX_VALIDATION`), so a typo never silently changes a request. Responses never contain fields not listed in the schema.
- **Times** are integers, Unix time in milliseconds. **Ids**: tenant ids, app names, node ids and secret names follow the patterns in the schemas; app names are at most **50** characters (stricter than `artifact.md`'s 63, so that a preview host `<app>-<12 hex>` fits one DNS label).
- **Request id.** Every response carries `x-renox-request-id` (a ULID); error bodies repeat it.
- **Errors.** Every non-2xx response with a body is:

  ```json
  { "error": { "code": "RENOX_CONFLICT", "message": "The request conflicts with the current state.", "request_id": "01JBQ3Z7MA0000000000000014", "details": [ { "field": "state", "reason": "rejected -> activating is not allowed" } ] } }
  ```

  `code` and the fixed `message` are rows of [`errors.md`](errors.md) (section 12 lists them). `deployment` names the hash for deploy and activation errors. `details` is present only where section 12 says so: artifact violations `{ rule, path or field, reason }`, field errors `{ field, reason }`, or an activation error. Nothing in an error is built from a secret value, a server file path, an internal hostname or address, an SQL statement of ours, or a stack.
- **Idempotency.** `PUT` is idempotent; an upload of the same hash is idempotent (section 4); activation and rollback of the deployment that is already active return 200 with no change and no route message.

## 2. Authentication, scopes, audit

| Caller | Header | Token format | Stored as | Issued by |
| --- | --- | --- | --- | --- |
| Tenant (CLI, dashboard, CI, MCP) | `Authorization: Bearer renox_pat_…` | `renox_pat_` + 32 characters of base32 (`[a-z2-7]`, 160 random bits) | SHA-256 hex, plus id, name, scopes, `expires_at`, `last_used_at`, `revoked_at` | `POST /v1/tokens` (a token with `tokens:write`), or the bootstrap token of `POST /v1/admin/tenants`. #113 adds accounts and sessions |
| Node (`renox-worker`) | `Authorization: Bearer renox_node_…` | `renox_node_` + 32 base32 characters | SHA-256 hex, bound to one `node_id` | `POST /v1/admin/nodes` |
| Operator | `Authorization: Bearer renox_op_…` | `renox_op_` + 32 base32 characters | SHA-256 hex in the API's environment (`CONTROL_OPERATOR_TOKEN_SHA256`); never in Postgres | Out of band |

Rules:

- A token is looked up by the SHA-256 of the presented value; the value itself is never stored or logged. A token value is returned exactly once, in the response that creates it.
- **401 `RENOX_UNAUTHENTICATED`** with `WWW-Authenticate: Bearer realm="renox"`: no `Authorization` header, a malformed or unknown token, an expired or revoked token, or a token of the wrong kind for the endpoint (a node token on a tenant endpoint and the reverse). The body does not say which.
- **403 `RENOX_TOKEN_SCOPE`**: a valid token without the operation's scope (`x-renox-scope` in the OpenAPI file), or a node token whose `node_id` differs from the `{node_id}` in the path or a `node_id` in the body.
- **404 `RENOX_NOT_FOUND`** for any resource outside the caller's tenant, never 403, so ids of other tenants cannot be enumerated (`docs/24-threat-model.md` E, IDOR row). The tenant id always comes from the token, never from a path, query, header or body.
- **Scopes** (tenant tokens): `apps:read`, `apps:write`, `deploy`, `logs:read`, `secrets:read` (names only), `secrets:write`, `domains:write`, `tokens:write`; each either alone (every app of the tenant) or as `<scope>:<app>` (one app); `*` holds all of them. A token creates only tokens whose every scope it holds itself (400 `RENOX_VALIDATION` otherwise), so no token can mint a stronger one. Expiry: 1 to 365 days, default 90. #113 adds roles and the permission matrix on top of the same scope names.
- **Rate limits** (*proposed*): per tenant token 20 requests/s with a burst of 100, and 10 uploads per minute; per source IP for unauthenticated requests 5/s. Over the limit: 429 `RENOX_RATE_LIMITED` with `Retry-After` in seconds. Node tokens are not rate limited in version 0.
- **Audit.** Every mutating request (`POST`, `PUT`, `DELETE`), whatever its outcome, writes one audit row: time, tenant, actor (`token:<id>`, `node:<id>`, or `operator`), action (the `operationId`), target (app, hash, secret name, hostname, token id), HTTP status, request id. Audit rows never contain a request body, a secret value, or a token value. Audit rows are append-only.

## 3. Apps

`POST /v1/apps` creates an app in the caller's tenant (`apps:write`); the name must be unused across the platform (409 `RENOX_CONFLICT` otherwise, without saying who holds it). `GET /v1/apps` and `GET /v1/apps/{app}` return the app with its `active_deployment` (hash or `null`) and its served hostnames: `<app>.renox.app` (the platform domain is configuration) and every `verified` custom domain. An uploaded artifact's `manifest.app.name` must equal `{app}` (rule V3, `field: app.name`).

## 4. Upload and validation

`POST /v1/apps/{app}/deployments` (`deploy`):

- **Body**: the artifact tree (`artifact.md` section 1) as a POSIX tar (ustar or pax), entries relative to the artifact root (`manifest.json`, `code/…`; no leading directory), as `Content-Type: application/x-tar`, or the same tar gzip-compressed as `application/gzip`. The CLI produces it from the `renox build` `esm-dir` directory (#58).
- **Header** `x-renox-artifact-hash`: the hash the client computed. The server recomputes the content hash from the extracted files (`artifact.md` section 2); a mismatch is rule V2 and rejects the upload.
- **Body limit**: 100 MiB as sent (compressed or not) → 413 `RENOX_BODY_TOO_LARGE`, checked while streaming, before extraction.

Extraction streams the tar and stops at the **first** violation of the upload rules below; nothing beyond the caps is ever written to disk. These settle the caps of #95 (`artifact.md` Open 3):

| # | Rule | Cap |
| --- | --- | --- |
| T1 | Entry types: regular files and directories only. Symbolic links, hard links, character and block devices, FIFOs, and sparse files are rejected. pax extended headers are read only for `path` and `size` | — |
| T2 | Total uncompressed bytes of all file entries | 100 MiB (104,857,600), the V5 whole-artifact cap |
| T3 | Number of entries (files and directories) | 10,000 |
| T4 | Every entry path follows `artifact.md` section 1, "Paths" (no absolute path, no `..`, at most 32 segments and 512 bytes, NFC, no backslash or `:`), after one leading `./` is removed (`tar -C <dir> .` writes it; the `./` entry itself is skipped) | 32 segments |
| T5 | Size of one file entry | 20 MiB (the V5 `code/` cap) |
| T6 | gzip only: uncompressed bytes read ÷ compressed bytes read, checked continuously once 1 MiB has been decompressed | 50 : 1 |
| T7 | The same path appears twice, or a path appears as both a file and a directory | — |
| T8 | Wall-clock time for receiving and extracting the body | 30 s |

After extraction the shared validation package (`packages/artifact-validate`, the same code `renox check` runs, #52) applies V1–V12 to the tree and V10 against the tenant's tier. The secret and bundle-hygiene rules of #115 join the same package and report under their own rule ids in a minor version.

Outcomes:

| Case | Status | Body | Deployment record |
| --- | --- | --- | --- |
| New hash, valid | 201 | `Deployment`, state `validated` | Created: `uploaded` → `validated`; permissions from the manifest recorded as approved; the tar stored at `artifacts/<hash>.tar` |
| Hash already has a deployment in this app that is not `rejected` (any state up to `pruned`) | 200 | The existing `Deployment`, unchanged | None. A `pruned` deployment is revived to `uploaded` → `validated` and its object re-stored |
| Invalid | 422 `RENOX_DEPLOY_REJECTED` | `details`: every V violation found (at most 50), or the one T violation that stopped extraction | Created or replaced in state `rejected` with `violations`; no object stored |
| Re-upload of a `rejected` hash | as above | — | `rejected` → `uploaded`, validated again (a tier change can make V10 pass) |

Storage: the object key is `artifacts/<hash>.tar` (the uncompressed tar, so a node does not need gzip), written once with a conditional put and never overwritten. The same bytes uploaded by two tenants are one object; nothing in a response tells a tenant whether another tenant already stored a hash. Objects are deleted only when no deployment of any tenant in a state other than `pruned` refers to the hash.

### Sourcemaps (#128)

`PUT /v1/apps/{app}/deployments/{hash}/sourcemaps` (`deploy`) takes a tar (or gzip tar) of `*.map` files from `.renox/sourcemaps/<hash>/`, at most 50 MiB, the same T rules, `.map` files only (422 `RENOX_VALIDATION` otherwise). It is stored under the private prefix `sourcemaps/<tenant_id>/<hash>.tar`, is never part of the artifact or its hash, is never served from the app's origin, and is replaced by a later `PUT`. It is used only for symbolication in the dashboard and in `renox logs`.

## 5. Deployment states

`docs/05-tenant-lifecycle.md` "Lifecycle states", plus `rejected` (the outcome of validation, named there as a transition) and `activating` (the time between the activation request and the worker's answer, section 6). A deployment is identified by `(tenant, app, hash)`.

<!-- state-machine: deployment -->
| State | Meaning | Allowed next states |
| --- | --- | --- |
| `uploaded` | Body received and extracted, not yet validated | `validated`, `rejected` |
| `rejected` | Failed validation; `violations` says why. No object stored | `uploaded` |
| `validated` | Passed validation; artifact stored; not serving | `activating`, `pruned` |
| `activating` | An activation is in progress on the owning node; at most one per app | `active`, `validated` |
| `active` | The app's route entries point here; at most one per app | `superseded`, `suspended` |
| `superseded` | Replaced by a newer activation; retained for rollback | `active`, `pruned` |
| `suspended` | The tenant is suspended (billing, abuse); routes removed | `active` |
| `pruned` | Beyond the retention limit; record kept, object deleted when unreferenced | `uploaded` |

Every transition not in the table is refused with 409 `RENOX_CONFLICT`, `details: [{ field: "state", reason: "<from> -> <to> is not allowed" }]`, and nothing changes. Each transition writes an audit row and updates `updated_at`. The table is also `x-renox-state-machines.deployment` in the OpenAPI file; `validate.ts` checks that the two agree, and `control/api` enforces the transitions from that data.

- **Retention.** Per app, at most **50** deployments in `validated` or `superseded` together (`docs/04-isolation-security.md`, "50 versions retained"). When an upload or an activation would exceed it, the oldest of them by `updated_at` becomes `pruned`. `active`, `activating` and `suspended` deployments are never pruned. `rejected` records are deleted after 7 days.
- **Suspension.** Suspending a tenant moves each `active` deployment to `suspended` and publishes the removal of its route entries; the gateway then answers its hostnames like an unknown host (`artifact.md` section 5). Reinstatement moves them back to `active` and publishes them again. While suspended, uploads, activation and rollback are refused with 409.

## 6. Activation and rollback

`POST /v1/apps/{app}/activate` with `{ "hash": "<hash>" }` (`deploy`) is synchronous. It applies D17 (forward-only migrations, expand/contract) without ever letting a failing migration take down the live deployment (#96):

1. The target must be `validated` (an `active` target returns 200 unchanged; a `superseded` one is a rollback, below; anything else is 409). Another `activating` deployment of the same app → 409.
2. `validated` → `activating`. The owning node is the tenant's assignment (section 7). No healthy node → back to `validated`, `last_error: { stage: "no_worker" }`, 503 `RENOX_UNAVAILABLE` with `Retry-After: 5`.
3. The control plane sends `prepare` to that node on its stream with `secrets_version` = the app's latest secret version, a probe, and `deadline_ms` = 60,000.
4. The node, without touching the route table: fetches and verifies the artifact (`fetch`), fetches the secret bundle, runs every not-yet-applied migration file per module in order, **each file in its own transaction** (`migrate`), creates the new cell, which evaluates the modules (`load`), and runs the probe (`probe`). It answers `POST /v1/nodes/{node_id}/prepare-results`. The new cell stays warm and receives no traffic until the route delta of step 5 arrives.
5. `ok: true` → in one Postgres transaction: the target becomes `active` with `activated_at` and the pinned `secrets_version`; the previous `active` deployment becomes `superseded`; the route changes are recorded (target `active`, previous `draining`). The `route_delta` is published to every node within **100 ms** of the commit (#53). Response 200 with the deployment.
6. `ok: false` → `activating` → `validated` with `last_error` (stage, reason, and for `migrate` the module, file and SQLite message; for `probe` the HTTP status). 422 `RENOX_ACTIVATION_FAILED` with the error in `details`. The old deployment keeps serving; its route entries never changed. Migration files applied before the failing one stay applied (forward-only), so a later activation, after the file is fixed in a new upload, applies only the remaining files.
7. No answer within `deadline_ms` → as 6 with `stage: "timeout"`. A late `prepare_result` gets 409 and is discarded; the node discards the prepared cell when no route delta for it arrives within the deadline.

**Probe.** `GET` of `/` if a `GET` route matches `/`; otherwise the first `GET` route in manifest order whose pattern has no parameter or catch-all; if there is none, `probe` is `null` and only cell creation is checked. The probe request goes through the new cell directly with `x-renox-probe: 1`, the tenant's normal limits, and a 10 s timeout. It **passes for any status below 500**: a function app's only `GET` route may legitimately answer 401 or 404 to an anonymous request. A 5xx, a limit (`RENOX_CPU_LIMIT`, `RENOX_OOM`, `RENOX_DEADLINE`) or the timeout fails it. The probe is metered like any request, with `route` `GET <pattern>`.

**Rollback.** `POST /v1/apps/{app}/rollback` with `{}` or `{ "hash": "<hash>" }` (`deploy`) is a pointer switch: the target (default: the most recently `superseded` deployment by `updated_at`) must be `superseded`; it becomes `active`, the current `active` one becomes `superseded`, the secret version is re-pinned to the latest, and the route delta is published. No validation, no migrations, no probe. Rolling back across a migration is allowed: the older code must tolerate the newer columns (D17); `renox check --target <hash>` warns about columns it does not know (#96). With no `active` deployment (all suspended) → 409.

## 7. Nodes: registration, heartbeat, assignment, stream

- **Register.** At start and after every reconnect, a node sends `POST /v1/nodes/register` (`node_register`: `node_id`, `worker_version`, `region`, `max_cells`). The answer (`node_registered`) gives `heartbeat_interval_ms` (10,000), `unhealthy_after_ms` (30,000), `resync_interval_ms` (60,000) and the current `route_version`. The node then opens the stream and fetches a snapshot.
- **Heartbeat.** `POST /v1/nodes/{node_id}/heartbeat` every `heartbeat_interval_ms` with the node's route version and warm cell count; the answer carries the control plane's route version, and a node that is behind resyncs. A heartbeat from a node the control plane does not know (it never registered, or its registration was deleted) gets 409; the node registers again.
- **Health.** A node whose last heartbeat is older than `unhealthy_after_ms` is **unhealthy**: it is removed from the assignment set and its tenants are reassigned (below). The next heartbeat makes it healthy again; tenants move back only as the assignment function dictates. Recovering a tenant's SQLite file on the new node is F6 (#76); in F3 a reassigned tenant starts from the node's local file if it has one.
- **Assignment** (consistent hashing over healthy nodes, rendezvous form): the owner of tenant `t` is the healthy node `n` with the largest `sha256(t + "\n" + n)` compared as lower-case hex, ties broken by the smaller `node_id`. Removing a node moves only its own tenants; adding one moves only the tenants it now wins. When the owner of a tenant changes, every route entry of that tenant is republished with the new `node_id` and a new version. A node serves only entries whose `node_id` is its own and answers other hostnames like unknown hosts; routing a request to the owning node is the front door's job (Open 2).
- **Stream.** `GET /v1/nodes/{node_id}/stream` is a Server-Sent Events response. Each event is `event: message` with one control message as `data:` (one line of JSON): `route_delta`, `resync`, `prepare`, `certificate_update`, `certificate_remove`. The first event after connecting is always `resync` with the current route version. A `: keep-alive` comment is sent every 15 s; a node that sees nothing for 45 s reconnects. Reconnects back off from 1 s doubling to 30 s. Between API instances, changes fan out over Postgres `LISTEN`/`NOTIFY` (channel `renox_routes`, payload = the new route version); each instance reads the change rows and forwards them to the nodes connected to it. `prepare` is sent only to the owning node; everything else to every node.

## 8. Route table messages

A route entry (`$defs/route_entry`) is the `artifact.md` section 5 entry plus the F3 fields:

| Field | Meaning |
| --- | --- |
| `hostname`, `tenant_id`, `deployment_hash`, `status`, `updated_at` | As in `artifact.md` section 5 |
| `app` | The app the entry belongs to |
| `version` | The route version that last wrote this entry (#97). One integer sequence for the whole control plane: every upsert or removal of any entry takes the next value |
| `tier` | `free` or `paid`: the tenant's tier, which the node uses for its limits (replaces `worker.toml [tenant_tiers]` in controlled mode) |
| `node_id` | The tenant's owning node (section 7) |
| `secrets_version` | The secret-set version the deployment pins (section 9); a change makes the node recycle the cell with the new bundle |

Messages:

- `route_snapshot` (`GET /v1/nodes/{node_id}/routes`): `version` = the latest route version at the time of the read, and every current entry. `ETag: "<version>"`; with `If-None-Match` equal to it the answer is 304 with no body, so an unchanged table costs one small request.
- `route_delta` (stream): `prev_version`, `version`, `upserts[]` (full entries), `removals[]` (`hostname`, `deployment_hash`, `version`). One delta per committed change set, for example one activation.
- `resync` (stream): fetch a snapshot now.

Rules on the messages, checked by `validate.ts`:

| # | Rule |
| --- | --- |
| R1 | Per hostname at most one `active` entry; `(hostname, deployment_hash)` unique, in a snapshot and within one delta (the V13 rule) |
| R2 | In a snapshot, no entry's `version` is above the snapshot's `version` |
| R3 | In a delta, `prev_version < version`; every upsert and removal has a distinct `version` in `(prev_version, version]` |

How a node applies them (#97):

1. It stores, per `(hostname, deployment_hash)`, the entry or a removal tombstone, with its version. An upsert or removal is applied only if its version is **greater** than the stored one; an older one is ignored. So reordered and duplicated deltas converge.
2. The node's table version is the `version` of the last snapshot or delta it applied. A delta whose `prev_version` differs from it reveals a gap: the node applies the delta under rule 1 and fetches a snapshot.
3. A snapshot replaces the whole table (and drops tombstones). The node fetches one after registering, after every `resync`, after a gap, and every `resync_interval_ms` with `If-None-Match`. So a lost delta is repaired within one interval.

Draining: activation publishes the new deployment `active` and the previous one `draining` in one delta; the node keeps finishing in-flight requests on the old cell. The control plane removes the `draining` entry 120 s later (twice the paid wall-clock limit). Hostnames: `<app>.renox.app` for every `active` deployment and each `verified` custom domain of the app (section 10). The local route table file of `mode = "local"` stays `artifact.md` version 0; the F3 fields exist only in these messages (`crates/renox-gateway` `RouteEntry` gains `version` in #97).

## 9. Secrets

| Rule | Value |
| --- | --- |
| Name | `^[A-Z][A-Z0-9_]{0,63}$` (`artifact.md` `permissions.secrets[]`) |
| Value | A UTF-8 string of at least 8 bytes and 8 characters and at most 64 KiB. Shorter values are refused at `PUT` with 400 `RENOX_VALIDATION`, because the runtime fails isolate creation on them and redaction needs them (`ops.md` section 3) |
| Count | At most 100 names per app |

- `PUT /v1/apps/{app}/secrets/{name}` sets or rotates one secret, `DELETE` removes it (`secrets:write`). Each creates a new **secret-set version** of the app (an integer, 0 = nothing set yet) and answers `{ name, version }`. `GET /v1/apps/{app}/secrets` (`secrets:read`) lists names, `updated_at` and the current version. **No endpoint ever returns a value to a tenant.**
- **Pinning.** A deployment pins the app's latest secret version when it becomes `active` (activation or rollback). Rotation does not change what a running deployment sees: it keeps its pinned version until the next activation, a rollback, or `POST /v1/apps/{app}/secrets/bump`, which re-pins the active deployment and publishes a delta with the new `secrets_version`. The set as of a version stays readable while a deployment that is not `pruned` pins it.
- **At rest** (envelope encryption, `docs/04-isolation-security.md` "Secrets"): each tenant has a 256-bit data key (DEK), stored only wrapped by the master key with AES-256-GCM. The master key comes from the API's environment (`CONTROL_MASTER_KEY`, 32 bytes, base64) behind a key-provider interface so a KMS adapter can replace it (F6, #120). Each value is encrypted with the tenant's DEK, AES-256-GCM, a random 96-bit nonce, and associated data `<tenant_id>\n<app>\n<name>\n<version>`, so a ciphertext cannot be moved to another row. The wrapped DEK records the master key id for rotation.
- **Delivery.** `GET /v1/nodes/{node_id}/secrets/{app}/{hash}?version=N` returns a `secrets_bundle` with the plaintext values of version `N`, filtered to the names in that deployment's `permissions.secrets`, only to the node the tenant is assigned to and only for a deployment that is `activating` or `active` (404 otherwise). `Cache-Control: no-store`. The node keeps it in memory only (the `SecretsSource` trait of #55) and injects it at isolate creation.
- Values never appear in logs, audit rows, error bodies, metrics, or any tenant-facing response. Audit rows of secret writes carry the name and the version only.

## 10. Domains and certificates

`POST /v1/apps/{app}/domains` with `{ "hostname": … }` (`domains:write`) attaches a custom domain and returns the TXT record to create: `_renox-verify.<hostname>` = `rnx-verify-<26 base32 characters>`. `GET` lists and reads domains (with `dns`: `pending`, `ok`, `not_pointing`, and the certificate state); `DELETE` detaches. A hostname is never served before it is `verified` (`docs/05-tenant-lifecycle.md`, "Custom domains and DNS"; failure mode "Unverified custom domain"). States (#114):

<!-- state-machine: domain -->
| State | Meaning | Allowed next states |
| --- | --- | --- |
| `pending` | Added; waiting for the TXT record; not served | `verified`, `released` |
| `verified` | TXT matched; served; certificate issued or being issued | `detached` |
| `detached` | Removed by the tenant, or the TXT check failed; not served; still owned by the tenant for 30 days | `verified`, `released` |
| `released` | No longer owned; the hostname can be claimed again | — |

- A hostname is owned by at most one tenant in any state but `released`. Adding a hostname another tenant owns → 409 `RENOX_CONFLICT` with `details: [{ field: "hostname", reason: "not available" }]` and nothing about the owner. `DELETE` moves `verified` → `detached` and `pending` → `released`; `detached` → `released` after 30 days. The TXT record is re-checked every 7 days and before every certificate order; a failure moves `verified` → `detached` (serving stops), a later success moves it back.
- Certificates (#59): ACME, HTTP-01 through the node's `:80` listener (`/.well-known/acme-challenge/*`, #162), renewal 30 days before expiry. Certificates and keys are stored encrypted with the platform's own DEK, the same scheme as section 9. When a certificate is issued or renewed, every node receives `certificate_update` (hostname, version, `not_after`) on its stream and fetches `GET /v1/nodes/{node_id}/certificates/{hostname}` (`certificate_bundle`, `Cache-Control: no-store`), then reloads its certificate store without dropping connections. When a domain leaves `verified`, nodes receive `certificate_remove`. Keys never travel on the stream and never enter a tenant cell.

## 11. Logs and meters

- **Meters.** `POST /v1/ingest/meters` is the HTTP sink reserved in `meter.md` section 5: the body is one batch envelope (`meter-record.schema.json`); `node_id` must equal the token's node (403 otherwise); records are de-duplicated on `request_id` (`meter.md` section 4); 202 `{ accepted, duplicates }` means persisted. A batch with an unknown `schema_version` gets 400 and the node keeps it for replay.
- **Logs.** The node's `HttpLogSink` (#55) sends `log_batch` messages (1–1,000 lines, each already redacted on the node, with `source`: `server`, or `client` for browser events from #126) to `POST /v1/ingest/logs`; 202 `{ accepted, duplicates }`. Lines are de-duplicated on `(node_id, ts, request_id, message)` within one batch only; at-least-once delivery may show a line twice.
- **Reading logs.** `GET /v1/apps/{app}/logs` (`logs:read`) is a Server-Sent Events response: `event: log`, `id: <ts>-<n>`, `data:` one `log_line`. Without `follow` it returns the last 100 lines (or the lines since `since`) and closes; with `follow=true` it stays open, with `: keep-alive` every 15 s, and resumes from `Last-Event-ID` after a reconnect. Filters: `source` (`all`, `server`, `client`), `deployment`. Retention is 7 days (*proposed*).

## 12. Error codes

| Code | HTTP | Where | `details` |
| --- | --- | --- | --- |
| `RENOX_VALIDATION` | 400 (422 for a sourcemap tar) | Malformed JSON, unknown field, a value outside its pattern or range, a secret value under 8 bytes, a non-`.map` file in a sourcemap tar | `{ field, reason }` |
| `RENOX_UNAUTHENTICATED` | 401 | Section 2 | — |
| `RENOX_TOKEN_SCOPE` | 403 | Section 2 | — |
| `RENOX_NOT_FOUND` | 404 | Unknown resource, or one of another tenant | — |
| `RENOX_CONFLICT` | 409 | A transition not allowed by section 5 or 10; a name or hostname taken; another activation in progress; a tenant suspended; an unknown node heartbeating; a late `prepare_result` | `{ field, reason }` |
| `RENOX_BODY_TOO_LARGE` | 413 | A body over its limit (sections 1 and 4) | — |
| `RENOX_DEPLOY_REJECTED` | 422 | Upload validation, V1–V13 and T1–T8 (section 4) | `{ rule, path or field, reason }`, at most 50 |
| `RENOX_ACTIVATION_FAILED` | 422 | The node reported a failure or timed out (section 6) | one activation error |
| `RENOX_RATE_LIMITED` | 429, `Retry-After` | Section 2 | — |
| `RENOX_INTERNAL` | 500 | A bug; the request id finds the operator log | — |
| `RENOX_UNAVAILABLE` | 503, `Retry-After` | No healthy node for an activation; Postgres or object storage unreachable | — |

The rows, with fixed messages and guidance, are in [`errors.md`](errors.md) ("Control API" and "Deploy"). The CLI quotes them and adds its own exit codes (#90, #58).

## 13. Examples

- [`schemas/deploy-api.yaml`](schemas/deploy-api.yaml): every operation has request examples (and `x-renox-invalid-examples` that must fail, each with the expected reason in `x-expect`) and response examples for each status with a body, including the error bodies.
- [`examples/deploy-api/`](examples/deploy-api/): `<message>.valid.json` and `<message>.<case>.invalid.json` for each message of `control-messages.schema.json`; each invalid file names its reason in `$comment` with `[expect: …]`.

## Open

1. **Presigned uploads.** Version 0 uploads through the API (100 MiB cap). A presigned direct-to-storage upload with a `POST …/deployments/{hash}/complete` step can be added as a minor change if uploads become a bottleneck (B15, #60).
2. **Front door.** Each node serves only the tenants assigned to it (section 7). How a request for `<app>.renox.app` reaches the owning node (DNS per tenant, an L4 balancer that hashes on SNI, or forwarding between nodes) is not decided; F3 runs one node per region, where the question does not arise.
3. **Preview hosts.** `<app>-<first 12 hex of the hash>.renox.app` for `validated` and `superseded` deployments is not published in version 0: a preview would run code against a schema its migrations have not reached. Revisit with a read-only database mode.
4. **Node authentication.** Bearer node tokens over TLS. mTLS with per-node certificates (#120 key hierarchy) is the stronger option for F6.
5. **Internal tenants.** #164 decides by ADR whether the dashboard tenant reaches this API over the public path or through a `ctx.platform` op for tenants flagged `internal` in the route entry; option (b) adds an optional `internal` field to `route_entry` (a coordinated change of both sides, since the schema rejects unknown keys).
6. **Rate-limit numbers** in section 2 are proposals for #113.
7. **Probe pass rule.** "Any status below 500" (section 6) differs from #96's "non-2xx fails". If tenants want a stricter check, a manifest `healthcheck` route (reserved) can require 2xx.
8. **Log retention and volume** (7 days, the per-tenant volume limit of `ops.md` section 4) are proposals for #56 and #57.
