# Contract: deploy API

| | |
| --- | --- |
| Version | **0.4** (F6, #303: the account and MFA endpoints of #113 and #293 as section 18, with a user token accepted on them; tenant erasure `deleteTenant` and `getTenant` in section 3; break-glass impersonation in section 17 with the scope `ops:impersonate`; `disk` on the heartbeat and `getNode` in section 7; latency percentiles and realtime fields on `UsageHour` in section 11; the reach of an `ops:read`-only token in section 2). 0.3.1 (F6, #273: patch, no new behaviour; the `fields.frames` sentence of section 11 for #261, `renox_op_` in `TokenCreated`, the operator id form, `GET /v1/ops/tenants/{tenant_id}` with the `ops:read` scope for the console of #259 and the status panel of #296, Open 5 closed by D23). 0.3 (F6, #251). HTTP paths are under `/v1`; every worker message carries `schema_version: 0`. Adding an endpoint, an optional request field, a rule id, or an error row is minor. Removing or renaming a field, a path, or a state, or changing a status code, is breaking: `/v2` and `schema_version: 1`. History: "Changelog" at the bottom |
| Producers | `control/api` (P12) |
| Consumers | `cli/` (P11): `renox deploy`, `logs`, `secrets`, `domains`, `tokens` (#58, #113); `crates/renox-cell` (P5): the controlled-mode worker (#55, #96, #97, #98, #162); the dashboard (P13, #57, including the usage screen of section 11, the Database screen of section 14, #258, and the operator console of section 17, #259); the remote MCP (#62); from 0.3 the control plane is also a client of each node's listener (section 15: `crates/renox-cell`, #255, #259; `control/api`, #257, #258) |
| Machine-readable | [`schemas/deploy-api.yaml`](schemas/deploy-api.yaml) (OpenAPI 3.1, every endpoint with request and response examples); [`schemas/control-messages.schema.json`](schemas/control-messages.schema.json) (JSON Schema 2020-12: worker registration, heartbeat, route table, activation, bundles, log batches, and the node listener messages of 0.3); [`schemas/node-listener.yaml`](schemas/node-listener.yaml) (OpenAPI 3.1: the endpoints a node serves to the control plane, section 15); meter batches are [`schemas/meter-record.schema.json`](schemas/meter-record.schema.json) |
| Examples | [`examples/deploy-api/`](examples/deploy-api/): one or more valid and invalid examples per worker message; HTTP bodies have their examples inside the OpenAPI file (`examples` and `x-renox-invalid-examples`) |
| Checker | `bun run docs/contracts/validate.ts` (schemas, examples, rules R1–R3, the state machines below against `x-renox-state-machines`, error codes against `errors.md`; for the 0.3 operations also caller, audit row and error codes per operation, and FO1–FO6 against B18) |
| Sources | `docs/05-tenant-lifecycle.md` ("Deploy pipeline", "Lifecycle states", "Custom domains and DNS"), `docs/03-architecture.md` (control plane components), `docs/04-isolation-security.md` ("Secrets", "Operational security"), `docs/06-data.md` (control plane in Postgres), [`artifact.md`](artifact.md), [`meter.md`](meter.md), [`errors.md`](errors.md), `docs/24-threat-model.md` section E; for 0.3 `docs/06-data.md` ("Replication and backup tiers", "Local tooling"), `docs/19-platform-wireframes.md` 3.8 and 5, `docs/14-benchmarks.md` B18 and B19 |

The deploy API is how a tenant developer's code gets from a laptop or CI into the route table, and how worker nodes learn what to run. It has three kinds of callers, each with its own token: **tenants** (CLI, dashboard, MCP), **nodes** (`renox-worker` in `mode = "controlled"`), and **operators**. The control plane is the source of truth (Postgres) and owns object storage for artifacts; a node never reads Postgres or the artifact bucket's listing.

```
renox deploy ──► POST /v1/apps/{app}/deployments   (tar) ──► validate (V1–V16, T1–T8) ──► artifacts/<hash>.tar
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
| Tenant (CLI, dashboard, CI, MCP) | `Authorization: Bearer renox_pat_…` | `renox_pat_` + 32 characters of base32 (`[a-z2-7]`, 160 random bits) | SHA-256 hex, plus id, name, scopes, `expires_at`, `last_used_at`, `revoked_at` | `POST /v1/tokens` (a token with `tokens:write`), the `renox login` device flow, the dashboard, or the bootstrap token of `POST /v1/admin/tenants` |
| Node (`renox-worker`) | `Authorization: Bearer renox_node_…` | `renox_node_` + 32 base32 characters | SHA-256 hex, bound to one `node_id` | `POST /v1/admin/nodes` |
| Tenant user (dashboard) | `__Host-renox_session` cookie, plus `X-Renox-CSRF` on `POST`, `PUT`, `PATCH`, `DELETE` | Random session value | SHA-256 hex, bound to one user and one current tenant; absolute expiry 30 days, idle expiry 24 hours | `POST /v1/account/login` (#113; section 18 from 0.4; the rest of the account endpoints, sign-up, email verification, password reset, sessions, invitations and the team, are listed in `control/api/README.md`, "Account endpoints", and join this contract when a consumer outside `control/` needs them) |
| Operator | `Authorization: Bearer renox_op_…` | `renox_op_` + 32 base32 characters | The bootstrap token: SHA-256 hex in the API's environment (`CONTROL_OPERATOR_TOKEN_SHA256`), never in Postgres. From 0.3 also tokens of operator accounts: SHA-256 hex in Postgres with the scope `ops:write` or (0.3.1) `ops:read` (section 17) | Bootstrap: out of band. Operator account tokens: `POST /v1/tokens` by an account flagged `operator`; the answer is a `TokenCreated` whose `token` starts with `renox_op_` (0.3.1: the schema allowed only `renox_pat_`) |
| Control plane, calling a node (0.3) | `Authorization: Bearer renox_cb_…` on the node listener | `renox_cb_` + 32 base32 characters | Generated per node registration and returned once in `node_registered.callback_token`; the node keeps it in memory, the control plane encrypted with its own DEK (section 9) | `POST /v1/nodes/register` (section 15) |

Rules:

- A token is looked up by the SHA-256 of the presented value; the value itself is never stored or logged. A token value is returned exactly once, in the response that creates it.
- **401 `RENOX_UNAUTHENTICATED`** with `WWW-Authenticate: Bearer realm="renox"`: no `Authorization` header, a malformed or unknown token, an expired or revoked token, or a token of the wrong kind for the endpoint (a node token on a tenant endpoint and the reverse). The body does not say which.
- **403 `RENOX_TOKEN_SCOPE`**: a valid token without the operation's scope (`x-renox-scope` in the OpenAPI file), or a node token whose `node_id` differs from the `{node_id}` in the path or a `node_id` in the body.
- **404 `RENOX_NOT_FOUND`** for any resource outside the caller's tenant, never 403, so ids of other tenants cannot be enumerated (`docs/24-threat-model.md` E, IDOR row). The tenant id always comes from the token, never from a path, query, header or body.
- **Scopes** (tenant tokens): `apps:read`, `apps:write`, `deploy`, `logs:read`, `secrets:read` (names only), `secrets:write`, `domains:write`, `tokens:write`; each either alone (every app of the tenant) or as `<scope>:<app>` (one app); `*` holds all of them. `ops:write` (0.3) and `ops:read` (0.3.1) are not tenant scopes: no role holds them, `*` does not include them, and only an account flagged `operator` can create a token with them (403 `RENOX_TOKEN_SCOPE` otherwise); such a token holds nothing else and acts on no tenant's own endpoints (section 17). `ops:write` grants `ops:read`: a token with `ops:write` reads the operator endpoints too, and `ops:read` alone is a read-only operator token (for the console's status panel and the observability page, #296). **Reach of an `ops:read`-only token (0.4):** `getOpsTenant` and `getNode` (section 7), and nothing else of this contract: every `ops:write` operation, `ops:impersonate` and every tenant, node and account endpoint answer it 403 `RENOX_TOKEN_SCOPE`. `createToken` accepts `scopes: ["ops:read"]` alone from an operator account. **`ops:impersonate` (0.4)** is the break-glass scope of section 17: neither `ops:write` nor the bootstrap token grants it, only a token an operator account creates with it explicitly (alone or with `ops:read`, expiry at most 1 day) holds it. A token creates only tokens whose every scope it holds itself (400 `RENOX_VALIDATION` otherwise), so no token can mint a stronger one. Expiry: 1 to 365 days, default 90. Roles and the operation table: section 2.1.
- **Rate limits** (*proposed*): per tenant token 20 requests/s with a burst of 100, and 10 uploads per minute; per source IP for unauthenticated requests 5/s. Over the limit: 429 `RENOX_RATE_LIMITED` with `Retry-After` in seconds. Node tokens are not rate limited in version 0.
- **Audit.** Every mutating request (`POST`, `PUT`, `DELETE`), whatever its outcome, writes one audit row: time, tenant, actor (`token:<id>`, `node:<id>`, or `operator`), action (the `operationId`), target (app, hash, secret name, hostname, token id), HTTP status, request id. Audit rows never contain a request body, a secret value, or a token value. Audit rows are append-only. A read of operator data (`getOpsTenant`, 0.3.1) is audited too, as the one exception to "mutating requests only": operators read other people's tenants.
- **Operator ids (0.3.1).** Wherever this contract names the operator who acted (`move_request.operator` on the node listener, the `operator` of an action in `getOpsTenant`, the audit row's target), the value is `operator` for the bootstrap token or the **account id** `acct_<ulid>` of the operator account (`^(operator|acct_[0-9A-Za-z]{16,32})$`, `OperatorId` in the OpenAPI file). The control plane's own user ids, `usr_<ulid>` (the account endpoints of #113, sessions, the `users` table), never leave the API through an operator reference: the API maps `usr_<ulid>` to `acct_<ulid>` (same ULID) when it sends one. 0.3 wrote `acct_…` in the schema and `usr_…` in its prose; the schema was right.

### 2.1 Roles, permissions, and the operation table (#113)

A tenant principal is a token or a session, always bound to one tenant (`docs/24-threat-model.md` E, "Teammate with too much power"). Each tenant member has one **role**: `owner` (exactly one per tenant), `admin`, `developer`, `viewer`. A **permission** is either one of the token scopes of section 2 or one of five session-only permissions that no token ever holds: `team:read`, `team:write`, `billing`, `apps:delete`, `tenant:delete`.

The request is allowed when:

- **Session**: the user's current role in the session's tenant holds the operation's permission (matrix below). Otherwise 403 `RENOX_TOKEN_SCOPE` with `details: [{ field: "role", reason: "<role>" }]`.
- **Token**: the token's scopes hold the permission (for `{app}` operations, unscoped or `<scope>:<app>`), **and**, for a token a user created, that user's *current* role holds it too. A token without a user (the operator's bootstrap token) acts with its scopes alone. When its user leaves the tenant the token answers 401. A token never holds a session-only permission.
- **Deploy** additionally needs a verified email address of the acting user (403, `details: [{ field: "email", … }]`).
- Ownership changes only by an owner transfer that the owner proposes and the proposed user accepts; `owner` cannot be granted, changed, or removed directly.

Matrix (`yes` = the role holds the permission). Source of truth in code: `MATRIX` in `control/api/src/tenancy/roles.ts`; `control/api/tests/tenancy.test.ts` ("the role table") checks this table, the README's copy, and the rows below against it.

<!-- role-matrix -->
| Permission | owner | admin | developer | viewer |
| --- | --- | --- | --- | --- |
| `apps:read` | yes | yes | yes | yes |
| `apps:write` | yes | yes | yes | — |
| `deploy` | yes | yes | yes | — |
| `logs:read` | yes | yes | yes | yes |
| `secrets:read` | yes | yes | yes | yes |
| `secrets:write` | yes | yes | — | — |
| `domains:write` | yes | yes | — | — |
| `tokens:write` | yes | yes | yes | — |
| `team:read` | yes | yes | yes | yes |
| `team:write` | yes | yes | — | — |
| `billing` | yes | — | — | — |
| `apps:delete` | yes | yes | — | — |
| `tenant:delete` | yes | — | — | — |

A developer's `tokens:write` lists and revokes only the tokens that developer created; owners and admins see and revoke all of the tenant's tokens.

Which permission each operation of this contract needs (`x-renox-scope` in the OpenAPI file; the same test checks every operation against `ROUTE_PERMISSIONS` in `roles.ts`):

<!-- operation-table -->
| Permission | Operations |
| --- | --- |
| `apps:read` | `listApps`, `getApp`, `listDeployments`, `getDeployment`, `listDomains`, `getDomain`, `getUsage`, `getBackups`, `getTenant` |
| `apps:write` | `createApp`, `setClientErrorStatus`, `exportBackup`, `restoreBackup`, `importDatabase` |
| `deploy` | `uploadDeployment`, `putSourcemaps`, `activateDeployment`, `rollbackDeployment` |
| `logs:read` | `streamLogs`, `listClientErrors`, `getClientError` |
| `secrets:read` | `listSecrets` (names only) |
| `secrets:write` | `putSecret`, `deleteSecret`, `bumpSecrets` |
| `domains:write` | `addDomain`, `removeDomain` |
| `tokens:write` | `createToken`, `listTokens`, `revokeToken`, `approveDeviceLogin` |
| `team:write` | `setTeamMfaRequired` |
| `tenant:delete` | `deleteTenant` |
| signed-in user | `logout`, `getMfa`, `startTotp`, `confirmTotp`, `passkeyOptions`, `registerPasskey`, `mfaChallenge`, `verifyMfa`, `regenerateRecoveryCodes`, `disableMfa` |
| node token | `registerNode`, `heartbeat`, `nodeStream`, `routeSnapshot`, `prepareResult`, `fetchArtifact`, `fetchSecrets`, `fetchCertificate`, `ingestMeters`, `ingestLogs` |
| operator token | `createTenant`, `suspendTenant`, `reinstateTenant`, `createNodeToken`, `setTenantTier`, `moveTenant` (`ops:write`), `getOpsTenant` (`ops:read`, 0.3.1), `getNode` (`ops:read`, 0.4), `impersonateTenant`, `endImpersonation` (`ops:impersonate`, 0.4) |
| none | `getHealth`, `login`, `startDeviceLogin`, `pollDeviceLogin` |

The session-only permissions guard the account and team endpoints of #113 (`team:read`, `team:write`) and the billing and delete operations that arrive with #57 and F7; they appear in this contract when those endpoints do: from 0.4 `team:write` (`setTeamMfaRequired`, section 18) and `tenant:delete` (`deleteTenant`, section 3). A **signed-in user** row is a caller of section 18: a session, or (0.4) a user token, with no tenant permission needed.

Tests per row: the matrix and the operation table above, `control/api/tests/tenancy.test.ts` ("the role table"); a viewer refused `deploy` and a wrong scope refused, `accounts.test.ts` ("expired → 401, revoked → 401, wrong scope → 403, viewer deploying → 403; each audited"); a token capped by its user's current role, "a user's token acts with at most the user's current role, and stops when the user leaves"; `tokens:write` per role, "developers see and revoke only their own tokens; owners see all"; `secrets:write` and `team:write`, "viewer and developer cannot write secrets or manage the team; admin can; tokens never manage the team"; ownership, "role changes are audited; the owner's role and removal go only through a transfer"; app-scoped tokens, `auth.test.ts` ("missing scope → 403 RENOX_TOKEN_SCOPE; app-scoped token works on its app only"); another tenant's ids → 404, `control/api/test/idor/`.

## 3. Apps

`POST /v1/apps` creates an app in the caller's tenant (`apps:write`); the name must be unused across the platform (409 `RENOX_CONFLICT` otherwise, without saying who holds it). `GET /v1/apps` and `GET /v1/apps/{app}` return the app with its `active_deployment` (hash or `null`) and its served hostnames: `<app>.renox.app` (the platform domain is configuration) and every `verified` custom domain. An uploaded artifact's `manifest.app.name` must equal `{app}` (rule V3, `field: app.name`).

**Databases (0.3).** A tenant has one SQLite file (`docs/06-data.md`), and every app of the tenant opens it, unless the app has a **database of its own**: an app created with `"staging": true`, or an app created by a restore (section 14). Its database id is `<tenant_id>.<app>`; the tenant's shared file is the database id `<tenant_id>`. The app answer carries `staging` and `database`; route entries carry `database` (section 8). A database is chosen when the app is created and never changes.

**Tenant and erasure (0.4).** `GET /v1/tenants/{tenant_id}` (`getTenant`, `apps:read`) answers the caller's own tenant (`TenantDetail`: `tenant_id`, `name`, `tier`, `state`, `created_at`, and `erasure`, `null` until a deletion is requested); another tenant id is 404 like any resource of another tenant, so the path only repeats what the token already says (section 2). `DELETE /v1/tenants/{tenant_id}` (`deleteTenant`, `tenant:delete`, which only the **owner** holds and no token ever does, section 2.1) with `{ "confirm": "<tenant_id>" }` erases the tenant (PDPL right to erasure, `docs/24-threat-model.md` G, "Erasure incomplete"):

| Operation | Path | Permission | Audit row (`action`, target) | Errors |
| --- | --- | --- | --- | --- |
| `getTenant` | `GET /v1/tenants/{tenant_id}` | `apps:read` | none (read) | 401, 403, 404 |
| `deleteTenant` | `DELETE /v1/tenants/{tenant_id}` | `tenant:delete` (owner, session only) | `deleteTenant`: tenant, the erasure state reached, `completed_at` (a second row when the erasure ends, actor `platform`) | 400 (`confirm` is not the tenant id), 401, 403, 404, 409 `RENOX_CONFLICT` (a restore, an import or a move of the tenant is in progress) |

<!-- state-machine: erasure -->
| State | Meaning | Next |
| --- | --- | --- |
| `pending` | Requested and recorded; the answer is 202 with the erasure record | `erasing` |
| `erasing` | The routes are removed (one `route_delta` with every hostname of the tenant in `removals`), every token of the tenant is revoked, the owning node drops the tenant (`nodeDropTenant`, section 15, which also stops the sidecar), the Litestream generations of every database of the tenant and every export object under `exports/<tenant_id>/` (section 14) are deleted, the tenant's secrets, domains (moved to `released`), logs, client error groups and meter rows are deleted; each step is retried hourly | `done`, `failed` |
| `done` | Every step confirmed; `completed_at` is set and the owner is sent an email with it | — |
| `failed` | A step still failed 24 hours after `requested_at`; an operator alert row is written and the record names the step in `failure` | `erasing` (an operator retry) |

- The answer and the `erasure` field of `getTenant` are `{ state, requested_at, completed_at, failure }` (`Erasure` in the OpenAPI file). A second `DELETE` while an erasure exists answers 202 with the same record and changes nothing.
- **Time box.** An erasure reaches `done` within 24 hours of `requested_at` while the owning node and the replica store are reachable; a node that is down is dropped when it comes back (FO4), before it is healthy again, and the erasure waits for it. Point-in-time restore is impossible from `erasing` on. Backups held by the replica store's own versioning expire with its lifecycle (at most 7 days, `ops/terraform`), the window `docs/24-threat-model.md` documents.
- **What stays.** The audit rows of the tenant (append-only, section 2; they carry ids, never data) and a tombstone of the tenant (`tenant_id`, `name`, the erasure record) for 30 days, during which the tenant id cannot be created again. Members keep their accounts; their sessions answer `getTenant` (the tombstone) and the account endpoints, nothing else of the tenant. The billing period is closed by F7's billing, not by this operation.
- **Refusals.** 409 `RENOX_CONFLICT` while a restore, an import or a move of the tenant is in progress (`details: [{ field: "tenant", reason: "restore in progress" | "import in progress" | "moving" }]`); erase after it ends. `confirm` that is not the tenant id is 400 `RENOX_VALIDATION` with `details: [{ field: "confirm", reason }]`. A token (any scope, `*` included) is 403: erasure is a person's decision.

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

After extraction the shared validation package (`packages/artifact-validate`, the same code `renox check` runs, #52) applies V1–V12 and V14–V22 to the tree (artifact versions 0, 1, and 1.1; V17–V22 are the module rules of `artifact.md` 1.1, #227, without V17's lock match and V20's original hashes, which need `renox.lock` and the module trees that only `renox build` has) and V10 against the tenant's tier, then the bundle-hygiene rules of #115 (the same rule set `renox build` applies):

| # | Rule | Applies to |
| --- | --- | --- |
| H1 | Forbidden file: environment files (`.env`, `.env.*`), SSH keys (`id_rsa`, …), key and certificate files (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`), database files (`.sqlite`, `.sqlite3`, `.db` and their `-wal`, `-shm`, `-journal`), `.log` files, any `node_modules` segment, `.git`, any other dotfile or dot-directory except `public/.well-known/`, and a `public/` file over 5 MiB | Every path of the tree |
| H2 | A secret in a text file stored as it is: a high-confidence pattern (private-key blocks, AWS, GitHub, Stripe live, Slack and Google API keys, Slack webhook URLs, unsigned `alg: none` JWTs; the list is `PATTERNS` in `packages/artifact-validate/src/secrets.ts`) or a high-entropy string assigned to a secret-like name, unless the line, or a comment line just above it, carries `renox-allow-secret: <reason>` | Text files under `public/`, `migrations/`, `templates/`, except the generated `manifest.json`, `public/manifest.json` and `migrations/checksums.json` |

An H violation is a `details` entry `{ rule: "H1" | "H2", path, reason }` of 422 `RENOX_DEPLOY_REJECTED` and part of the `rejected` deployment's `violations`, like a V violation. An H2 `reason` gives the line, the pattern's description and a masked prefix (`sk_live_… (32 chars)`), **never the matched text**.

**Who scans `code/` for secrets.** The CLI is the only secret scanner for `code/`: `renox build` and `renox check --secrets` scan the **sources** before bundling and refuse to build on a finding. The control plane does not apply H2 to `code/`, for three reasons: bundling strips the comments that carry `renox-allow-secret`, so an allowed line would be refused at upload; vendored SDKs inside the bundle produce false positives no tenant can mark; and `code/` is executed by the worker, never served to a browser, so a secret there is not published (the public surface, `public/` and rendered `templates/`, is scanned at upload). The cost is accepted: a `code/` built by hand, without the CLI, can carry a secret in the artifact store (`docs/24-threat-model.md` B, "Secrets in logs, errors, bundle, responses"). The CLI prints its report locally; the dashboard (#57) shows the H violations of a rejected upload from `violations`, and does not receive the CLI's source report.

Outcomes:

| Case | Status | Body | Deployment record |
| --- | --- | --- | --- |
| New hash, valid | 201 | `Deployment`, state `validated` | Created: `uploaded` → `validated`; permissions from the manifest recorded as approved; the tar stored at `artifacts/<hash>.tar` |
| Hash already has a deployment in this app that is not `rejected` (any state up to `pruned`) | 200 | The existing `Deployment`, unchanged | None. A `pruned` deployment is revived to `uploaded` → `validated` and its object re-stored |
| Invalid | 422 `RENOX_DEPLOY_REJECTED` | `details`: every V violation found (V1–V22, at most 50), or the one T violation that stopped extraction | Created or replaced in state `rejected` with `violations`; no object stored |
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
- **Heartbeat.** `POST /v1/nodes/{node_id}/heartbeat` every `heartbeat_interval_ms` with the node's route version and warm cell count, and (0.4, optional) `disk: { level, free_bytes, watermark }`: the level of the node's data directory as its disk watermarks compute it (`ok`, `warn` at 85 % used, `critical` at 95 %, when new writes are refused; `docs/23-failure-modes.md` "Disk full"), the free bytes, and the watermark in percent that the level crossed (`null` at `ok`). The control plane stores the last report per node; an absent `disk` means the node does not report it (a worker older than 0.4) and is shown as unknown, never as `ok`. The answer carries the control plane's route version, and a node that is behind resyncs. A heartbeat from a node the control plane does not know (it never registered, or its registration was deleted) gets 409; the node registers again.
- **Node read (0.4).** `GET /v1/ops/nodes/{node_id}` (`getNode`, operator token with `ops:read`) answers `{ node_id, region, worker_version, healthy, last_heartbeat_at, route_version, cells, max_cells, disk }` from Postgres (`disk` the last reported object or `null`); an unknown node is 404. It is audited as a read of operator data, like `getOpsTenant`.
- **Health.** A node whose last heartbeat is older than `unhealthy_after_ms` is **unhealthy**: it is removed from the assignment set and its tenants are reassigned (below). The next heartbeat makes it healthy again; tenants move back only as the assignment function dictates. From 0.3 a reassignment is a **failover**: the new node restores the tenant's file from its replica before the route table points there, and the old node is told to drop the tenant (section 16, FO1–FO6).
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
| `process` (0.3, optional) | `shared` or `own`: whether the tenant's cells run in the node's shared worker process or in a child process of their own (#254). Missing means `shared`. The control plane writes `own` for every `paid` tenant and `shared` for every `free` one; an operator tier change (section 17) changes both fields in one delta |
| `database` (0.3, optional) | The database id the entry's cells open (section 3, "Databases"). Missing means the tenant's shared file (`tenant_id`) |

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
- **Logs.** The node's `HttpLogSink` (#55) sends `log_batch` messages (1–1,000 lines, each already redacted on the node, with `source`: `server`, or `client` for browser events from #126; a node never sends `platform`, which `ingestLogs` refuses with 400) to `POST /v1/ingest/logs`; 202 `{ accepted, duplicates }`. Lines are de-duplicated on `(node_id, ts, request_id, message)` within one batch only; at-least-once delivery may show a line twice.
- **Usage.** `GET /v1/apps/{app}/usage` (`apps:read`, #56) reads the hourly rollup of the app's meter records (`meter.md` section 7) in `[from, to)`: `from` defaults to the start of the current calendar month (UTC), `to` to the start of the next; `to` must be after `from` and at most 366 days later (400 `RENOX_VALIDATION` otherwise). The answer is `{ app, from, to, hours, total, quota }`: `hours` lists one row per hour that has records (`hour_start` plus the sums of `requests`, `cpu_ms`, `wall_ms`, `egress_bytes`, `fetch_sent_bytes`, `db_ms`, `db_rows`, `render_fuel`; from 0.4 optionally `latency_p50_ms` and `latency_p95_ms`, the percentiles of the hour's request `wall_ms`, and `realtime_conn_seconds` and `realtime_messages`, the sums of the meter 0.3 realtime fields of `meter.md`; an hour rolled up before 0.4 has none of the four), oldest first; `total` sums them; `quota` is the **tenant's** state for the current month over all its apps (`tier`, `period_start`, `period_end`, `used` and `limits` in the billing dimensions `requests`, `cpu_ms` = `cpu_ms + render_ms`, `egress_bytes` = `egress_bytes + fetch_sent_bytes`, and `over`, the dimensions above their limit). A non-empty `over` is the **over-quota signal**; in F3 nothing is suspended or throttled on it (suspension is F7). The rollup runs in the billing job (`control/billing`), so the last hour may lag by one job interval. The tier limits are proposals until F7 (`control/billing/src/quota.ts`).
- **Reading logs.** `GET /v1/apps/{app}/logs` (`logs:read`) is a Server-Sent Events response: `event: log`, `id: <ts>-<n>`, `data:` one `log_line`. Without `follow` it returns the last 100 lines (or the lines since `since`) and closes; with `follow=true` it stays open, with `: keep-alive` every 15 s, and resumes from `Last-Event-ID` after a reconnect. Filters: `source` (`all`, `server`, `client`, `platform`), `deployment`. A `source: platform` line (0.3) is written by the control plane itself, never by tenant code: failover (section 16), restore, export and import (section 14), and operator actions on the tenant (section 17); `fields.kind` names which (`failover`, `restore`, `export`, `import`, `tier`, `move`), and it never carries a secret, a URL to a backup, or an internal address. A line with `source: client` carries `fields.fingerprint`, the 16-hex fingerprint of its error group (section 11.1), added by the control plane at ingestion (a node's `log_batch` does not have it), so the Logs page can link the line to `GET /v1/apps/{app}/client-errors/{fingerprint}`; its `request_id` links it to the server lines of the same request. A server line whose `fields.stack` holds a stack also carries `fields.frames`: one `{ file, line, column, function, original }` per frame (at most 50), the shape of the client-events frames, with `original` from the deployment's private sourcemaps or null (0.3.1, #261: added by the control plane when the line is read, with a 2 ms budget per line after which the remaining frames stay raw; the stored line and `fields.stack` are unchanged). Retention is 7 days (*proposed*).
- **Client events and the caps.** Lines with `source: client` count toward the tenant's **daily** client-event cap only, never toward the per-minute log cap (`client-events.md` section 7, `ops.md` section 4). `GET /v1/apps/{app}/usage` reports the daily count as `client_events: { used_today, daily_cap, warning }` (counted since 00:00 UTC, `daily_cap` 144,000 free and 1,440,000 paid, *proposed* as in `client-events.md`; `warning` is true from 80 % of the cap, which is when the dashboard shows its warning). Events over the cap are dropped by the gateway (`daily_cap`), so `used_today` does not pass `daily_cap`.

### 11.1 Client error groups

Every client line with `kind` `js.*`, `htmx.*`, `csp.violation` or `realtime.*` is assigned to a **group** at ingestion (#128). The fingerprint is the first 16 hex characters of the SHA-256 of `kind`, the top frame's file (with content hashes in the file name stripped) and function, and the message without its `<kind>: ` prefix, with numbers, UUIDs and hex ids replaced by placeholders (for a kind without a stack, the target, transport, directive, status or code instead of the frame); it is per app. A group has: `status` (`open`, `resolved`, `ignored`), `first_seen`, `last_seen`, `count`, the message and top frame of the most recent event, `deployments` (event count per deployment hash, newest deployment first) and `regressed`.

- `GET /v1/apps/{app}/client-errors` (`logs:read`, `listClientErrors`) lists groups, most recently seen first. Filters: `status`, `since` (groups with `last_seen` at or after it), `deployment` (groups with an event on that deployment), `limit` (1–100, default 20) and `cursor` (the previous page's `next_cursor`, `null` on the last page).
- `GET /v1/apps/{app}/client-errors/{fingerprint}` (`logs:read`, `getClientError`) returns the group and its last 20 events, newest first. An event has `ts`, `client_ts`, `deployment_hash`, `request_id`, `message`, `url`, `ua` (the browser family, `client-events.md` section 4) and `frames`.
- `POST /v1/apps/{app}/client-errors/{fingerprint}` (`setClientErrorStatus`) with `{ "status": "open" | "resolved" | "ignored" }` sets the status and answers the group. It needs `apps:write`: no `logs:write` scope exists, and the status of a group is app state, like an app's other settings (Open 9). The audit row carries the fingerprint and the new status.
- **Regression.** An event for a `resolved` group from a deployment created after the one that was active when the group was resolved sets the status back to `open` and `regressed` to `true`; setting a status by hand clears `regressed`. An `ignored` group stays ignored and keeps counting.
- **Frames.** A frame is `{ file, line, column, function, original }`: the position as the browser reported it (kept always; 1-based, 0 when the browser gave none) and `original`, `{ file, line, column }` in the source file (1-based, a relative path without `..`), or `null` when no private sourcemap of the event's deployment matched (`PUT …/deployments/{hash}/sourcemaps`, section 4). Sourcemaps are never served from the app's origin or by any endpoint of this API.
- A fingerprint that is not 16 lowercase hex characters cannot exist, so it is 404 `RENOX_NOT_FOUND` like an unknown group or one of another tenant.
- Event text is untrusted: anyone can post to the client-events endpoint (`client-events.md` section 9). Consumers escape every field.

## 12. Error codes

| Code | HTTP | Where | `details` |
| --- | --- | --- | --- |
| `RENOX_VALIDATION` | 400 (422 for a sourcemap tar) | Malformed JSON, unknown field, a value outside its pattern or range, a secret value under 8 bytes, a non-`.map` file in a sourcemap tar, a usage range that is empty or longer than 366 days | `{ field, reason }` |
| `RENOX_UNAUTHENTICATED` | 401 | Section 2 | — |
| `RENOX_TOKEN_SCOPE` | 403 | Section 2 | — |
| `RENOX_NOT_FOUND` | 404 | Unknown resource, or one of another tenant | — |
| `RENOX_CONFLICT` | 409 | A transition not allowed by section 5 or 10; a name or hostname taken; another activation in progress; a tenant suspended; an unknown node heartbeating; a late `prepare_result` | `{ field, reason }` |
| `RENOX_BODY_TOO_LARGE` | 413 | A body over its limit (sections 1 and 4) | — |
| `RENOX_DEPLOY_REJECTED` | 422 | Upload validation, V1–V16, T1–T8 and H1–H2 (section 4) | `{ rule, path or field, reason }`, at most 50 |
| `RENOX_ACTIVATION_FAILED` | 422 | The node reported a failure or timed out (section 6) | one activation error |
| `RENOX_RATE_LIMITED` | 429, `Retry-After` | Section 2 | — |
| `RENOX_INTERNAL` | 500 | A bug; the request id finds the operator log | — |
| `RENOX_UNAVAILABLE` | 503, `Retry-After` | No healthy node for an activation; Postgres or object storage unreachable | — |
| `RENOX_BACKUP_UNAVAILABLE` | 503, `Retry-After` | Section 14: replication off for the database, replica or owning node unreachable, no generation yet | `{ field, reason }` |
| `RENOX_RESTORE_POINT_UNKNOWN` | 422 | Section 14: no generation covers the requested `timestamp` | `{ field: timestamp, reason }` |
| `RENOX_IMPORT_REJECTED` | 422 | Section 14: the app is not a staging app, or the file is not SQLite, fails `PRAGMA quick_check`, or has a name the authorizer refuses | `{ field, reason }` |
| `RENOX_TENANT_MOVING` | 503, `Retry-After` | Sections 15 and 17: a move of the tenant is in progress | — |

The rows, with fixed messages and guidance, are in [`errors.md`](errors.md) ("Control API" and "Deploy"). The CLI quotes them and adds its own exit codes (#90, #58).

## 13. Examples

- [`schemas/deploy-api.yaml`](schemas/deploy-api.yaml): every operation has request examples (and `x-renox-invalid-examples` that must fail, each with the expected reason in `x-expect`) and response examples for each status with a body, including the error bodies.
- [`examples/deploy-api/`](examples/deploy-api/): `<message>.valid.json` and `<message>.<case>.invalid.json` for each message of `control-messages.schema.json`; each invalid file names its reason in `$comment` with `[expect: …]`.
- [`schemas/node-listener.yaml`](schemas/node-listener.yaml): the same, for the node listener of section 15.

## 14. Backups, export, restore, import (0.3)

Each tenant database (section 3, "Databases") is replicated by a Litestream sidecar on its owning node (#255, `docs/06-data.md` "Replication and backup tiers"): WAL frames go to a replica (`file` for tests and the dev container, `s3` in a UAE region in production) within the node's sync interval (1 s by default), with a snapshot every hour and 24 hours of retention by default. A **generation** is one continuous WAL history; a restore can reach any time inside a generation's range.

| Operation | Path | Permission | Audit row (`action`, target) | Errors |
| --- | --- | --- | --- | --- |
| `getBackups` | `GET /v1/apps/{app}/backups` | `apps:read` | none (read) | 401, 403, 404 |
| `exportBackup` | `POST /v1/apps/{app}/backups/export` | `apps:write` | `exportBackup`: app, `size_bytes`, `sha256` (never the URL) | 400, 401, 403, 404, 503 `RENOX_BACKUP_UNAVAILABLE`, 503 `RENOX_TENANT_MOVING` |
| `restoreBackup` | `POST /v1/apps/{app}/backups/restore` | `apps:write` | `restoreBackup`: source app, new app, `timestamp`, generation | 400, 401, 403, 404, 409 `RENOX_CONFLICT` (name taken), 422 `RENOX_RESTORE_POINT_UNKNOWN`, 422 `RENOX_ACTIVATION_FAILED`, 503 `RENOX_BACKUP_UNAVAILABLE` |
| `importDatabase` | `POST /v1/apps/{app}/db/import` | `apps:write` | `importDatabase`: app, `size_bytes`, `sha256` | 401, 403, 404, 413 `RENOX_BODY_TOO_LARGE`, 422 `RENOX_IMPORT_REJECTED`, 503 `RENOX_BACKUP_UNAVAILABLE`, 503 `RENOX_TENANT_MOVING` |

Every row is audited whatever its outcome (section 2) and also writes one `source: platform` log line for the app (section 11).

- **Status.** `getBackups` answers `replication` (`none` or `litestream`), the sidecar `state` (`off`, `starting`, `replicating`, `stopped`), `replica` (`kind` `file` or `s3`, and the `region` for `s3`), `last_sync_at`, `lag_seconds`, `retention_hours`, `generations` (newest first, each `{ id, start, end }`), `db` (`size_bytes`, `quota_bytes`, `wal_bytes`: the header of `docs/19-platform-wireframes.md` 3.8) and `last_failover` (section 16). It is served from the owning node's `replication_status` (section 15); when the node does not answer within 2 s it is the last status the control plane saw, with `stale: true`.
- **Export.** `exportBackup` (`{}` or `{ "expires_in_seconds": 60–900 }`) asks the owning node for a consistent snapshot (`VACUUM INTO`, section 15), stores it under the private prefix `exports/<tenant_id>/<database>/<created_at>.db` and answers `201 { url, expires_at, created_at, size_bytes, sha256, masking }`. The URL is signed and expires after at most 15 minutes; the object is not readable without the signature, the prefix is not listable, and the dashboard and CLI download through the URL, never through this API. Exports are deleted after 24 hours. **Column masking is deferred to F7** (`masking` is always `none` in 0.3, Open 12).
- **Restore.** `restoreBackup` with `{ "timestamp": <ms>, "target": "new_app", "name": "<new app>" }` restores the app's database as of `timestamp` into a **new app** (0.3 has no in-place restore, Open 11): the control plane creates `name` in the caller's tenant with its own database `<tenant_id>.<name>`, asks the owning node to restore the source database's replica as of `timestamp` into it (`restore_request` with `source_database`, section 15), creates the new app's first deployment from the source app's active artifact and activates it (section 6, with the same probe). The answer is `201 { app, deployment, source_app, database, generation, restored_to }`. A `timestamp` that no generation covers (in the future, before the oldest generation, outside retention, in a gap) is 422 `RENOX_RESTORE_POINT_UNKNOWN`, checked before anything is created. A failed activation leaves the new app without an active deployment and answers 422 `RENOX_ACTIVATION_FAILED`; the restored file stays for a retry.
- **Import.** `importDatabase` takes the SQLite file as the body (`Content-Type: application/vnd.sqlite3`), at most the tier's `db_quota_bytes` (100 MB free, 10 GB paid; 413 over it). Only a **staging** app (section 3) accepts it; any other app is 422 `RENOX_IMPORT_REJECTED` with `details: [{ field: "app", reason: "not a staging app" }]`, so a production file can never be overwritten this way. The owning node checks the file before it swaps it in (section 15): it must be a SQLite database, pass `PRAGMA quick_check`, and every table, view, index and trigger name must follow the authorizer's rules (`<module>__<name>`; nothing under `sqlite_` but SQLite's own tables). The answer is `200 { app, database, size_bytes, sha256, tables }`.
- **Replication off.** A database whose node has replication off has no generations: `getBackups` says `replication: none`, `restoreBackup` is 503 `RENOX_BACKUP_UNAVAILABLE` with `details: [{ field: "replication", reason: "none" }]`; `exportBackup` and `importDatabase` still work (they need the node, not the replica).

## 15. The node listener (0.3)

From 0.3 the control plane also calls each node, on the **node listener**: an HTTP server the controlled worker runs on `[control] node_listen` and announces as `listen_url` in `node_register`. The machine-readable form is [`schemas/node-listener.yaml`](schemas/node-listener.yaml); the bodies are `$defs` of `control-messages.schema.json` with `schema_version: 0`.

- **Reachability.** The address is on the private network of ADR D23: only the control plane reaches it, and the worker refuses to start when the address is outside the blocked ranges and `fetch_blocked_addresses` (the rule of `[control] url`, #218), so tenant `fetch` can never reach it.
- **Authentication.** `Authorization: Bearer renox_cb_…`, the `callback_token` the control plane returned in `node_registered`. A new one is generated at every registration and the previous one stops working; the node keeps it in memory only and compares in constant time. Anything else is 401 `RENOX_UNAUTHENTICATED`. A `{node_id}` that is not the node's own is 404.
- **Errors** use the body of section 1.

| Operation | Path | Body → answer | Audit row | Errors |
| --- | --- | --- | --- | --- |
| `nodeRestoreTenant` | `POST /nodes/{node_id}/tenants/{tenant_id}/restore` | `restore_request` → `restore_result` | the caller's row on the control plane (failover, `restoreBackup`, `moveTenant`); the node logs one platform line | 400, 401, 422 `RENOX_RESTORE_POINT_UNKNOWN`, 503 `RENOX_BACKUP_UNAVAILABLE`, 503 `RENOX_TENANT_MOVING` |
| `nodeReplicationStatus` | `GET /nodes/{node_id}/tenants/{tenant_id}/replication[?database=]` | → `replication_status` | none (read) | 401, 404 |
| `nodeDropTenant` | `DELETE /nodes/{node_id}/tenants/{tenant_id}` | → `tenant_dropped` | failover on the control plane | 401 |
| `nodeSnapshotTenant` | `POST /nodes/{node_id}/tenants/{tenant_id}/snapshot[?database=]` | → the file (`application/vnd.sqlite3`, `x-renox-sha256`) | `exportBackup` on the control plane | 401, 404, 503 `RENOX_TENANT_MOVING` |
| `nodeImportTenant` | `PUT /nodes/{node_id}/tenants/{tenant_id}/import?database=` | the file → `import_result` | `importDatabase` on the control plane | 401, 413, 422 `RENOX_IMPORT_REJECTED`, 503 `RENOX_TENANT_MOVING` |
| `nodeMoveTenant` | `POST /nodes/{node_id}/tenants/{tenant_id}/move` | `move_request` → `move_result` | `moveTenant` on the control plane (operator, reason) | 400, 401, 503 `RENOX_TENANT_MOVING` |

Rules:

- **Restore before serving.** A node with replication on never opens a tenant file that is missing until a restore of it has answered 200. A request that needs such a file before then gets 503 `RENOX_DB_UNAVAILABLE` (`reason: restoring`, `errors.md`). A restore is accepted for a tenant that is not (yet) routed to the node (FO3).
- **Restore is idempotent.** The node drains the database's cells, quarantines a local file that fails `PRAGMA quick_check` as `<file>.corrupt-<ts>`, restores into a temporary file (`litestream restore`, with `-timestamp` when `timestamp` is set), checks it with `PRAGMA quick_check`, and renames it into place. A request whose file is already present and passes the check answers `source: local` and changes nothing, so the control plane may retry after a timeout. `restore_result` carries the generation, the file's SHA-256 and the time of its last transaction.
- **Drop.** `DELETE` drains the tenant's cells, stops its sidecar after the last frames ship, and from then on the node answers the tenant's hostnames like unknown hosts until a route entry for this node names the tenant again. The local file is removed only when the replica confirmed the last frames; otherwise it is kept and never served. An unknown tenant answers 200 with `cells_drained: 0`.
- **Snapshot.** `VACUUM INTO` a temporary file next to the tenant file (the cells keep serving), streamed back and then deleted.
- **Import.** The node refuses `database = tenant_id` (the shared file) as well as any file that fails the checks of section 14, then drains the staging database's cells and renames the file over it.
- **Move.** Section 17.

## 16. Failover (0.3)

When a node stops heartbeating, its tenants move to healthy nodes with their files. Each rule serves a B18 target (`docs/14-benchmarks.md`: kill a node, the base-tier tenant recovers from Litestream; **RTO ≤ 60 s, RPO ≤ 10 s**; kill criterion RPO > 60 s). `control/api/src/workers/failover.ts` implements them (#257).

| # | Rule | B18 target it serves |
| --- | --- | --- |
| FO1 | **Detection.** A node is unhealthy when its last heartbeat is older than `unhealthy_after_ms` (30 s, section 7); the health sweep of #53 runs at least every 5 s and starts a failover for each tenant whose owner just became unhealthy, at most 16 tenants at a time per sweep | B18 RTO ≤ 60 s: at most 35 s of the budget goes to detection |
| FO2 | **Target.** The new owner is the next healthy node in the tenant's rendezvous order (section 7) whose heartbeat reports fewer cells than its `max_cells`; if its restore fails, the one after it; the dead node is never a candidate | B18 RTO ≤ 60 s: a full node is skipped instead of timing out |
| FO3 | **Restore before route.** The control plane calls the target's `nodeRestoreTenant` (`reason: failover`, `timestamp: null`, `deadline_ms` 20,000) for each of the tenant's databases, and publishes the route delta that names the target only after every restore answered 200. A timeout or an error moves to the next candidate (FO2). When every candidate fails, the tenant stays on the dead node, nothing is published, and an alert row is written (failure mode "Node dies, restore fails") | B18 RPO ≤ 10 s: the target serves the replica's state, which is at most the sync interval (1 s) plus the replica lag behind the dead node; RTO ≤ 60 s: 20 s restore + 100 ms publish after a 35 s detection |
| FO4 | **The old node drains and refuses.** The delta moves every entry of the tenant to the target with a new version (section 8); a node serves only entries that name it, so the old node stops serving the tenant when it applies the delta. A node that comes back while its moved tenants are still recorded as `draining` is sent `nodeDropTenant` for each of them before it is healthy again, and never opens their files | B18 RPO ≤ 10 s: no write lands on the old copy after the move, so nothing written on the target is later lost to a returning node |
| FO5 | **Record.** Each move writes one tenant log line `source: platform`, `fields.kind: failover`, with `from_node`, `to_node`, the restored `generation`, `restored_to` and `elapsed_ms` (from the detection to the publish), one audit row (actor `platform`, action `failover`), and the record that `getBackups` reports as `last_failover` | B18 RTO and RPO are measured from these fields (`elapsed_ms`; `restored_to` against the last acknowledged write) |
| FO6 | **Targets.** The node's `sync_interval_ms` stays at most 1,000 and an alert fires when `lag_seconds` passes 10 (failure mode "Replica lagging / Litestream behind"); the restore deadline (20 s) plus the detection bound (35 s) plus the publish (100 ms) stays under 60 s. A change to any of these numbers is a change to this table | B18: RPO ≤ 10 s and RTO ≤ 60 s as budgets; the B18 result file (#257) reports both against them |

## 17. Operator actions (0.3)

| Operation | Path | Caller | Audit row | Errors |
| --- | --- | --- | --- | --- |
| `setTenantTier` | `POST /v1/ops/tenants/{tenant_id}/tier` | operator token with `ops:write` | `setTenantTier`: operator, tenant, from tier, to tier, reason, result | 400, 401, 403, 404, 503 `RENOX_TENANT_MOVING` |
| `moveTenant` | `POST /v1/ops/tenants/{tenant_id}/move` | operator token with `ops:write` | `moveTenant`: operator, tenant, target, from node, to node, reason, result | 400, 401, 403, 404, 409 `RENOX_CONFLICT`, 503 `RENOX_TENANT_MOVING`, 503 `RENOX_BACKUP_UNAVAILABLE` |
| `getOpsTenant` (0.3.1) | `GET /v1/ops/tenants/{tenant_id}` | operator token with `ops:read` (or `ops:write`) | `getOpsTenant`: operator, tenant (a read of operator data, section 2) | 401, 403, 404 |
| `impersonateTenant` (0.4) | `POST /v1/ops/tenants/{tenant_id}/impersonate` | operator token with `ops:impersonate` | `impersonateTenant`: operator, tenant, reason, `impersonation_id`, `expires_at` | 400, 401, 403, 404, 409 `RENOX_CONFLICT` (the operator already has an active impersonation of the tenant) |
| `endImpersonation` (0.4) | `DELETE /v1/ops/tenants/{tenant_id}/impersonate/{impersonation_id}` | operator token with `ops:impersonate` | `endImpersonation`: operator (or `platform` when the time box ends it), tenant, `impersonation_id`, `ended_by` (`operator`, `timeout`) | 401, 403, 404 |

- **Scope.** The two actions need `ops:write`: the bootstrap operator token (section 2) holds it, and so does a `renox_op_` token that an account flagged `operator` created (`POST /v1/tokens` with `scopes: ["ops:write"]`). The read needs `ops:read` (0.3.1), which `ops:write` grants; a read-only operator token is created with `scopes: ["ops:read"]`. A tenant token, a session, and an account without the flag get 403 `RENOX_TOKEN_SCOPE`; the existing roles of section 2.1 are unchanged and none of them holds an `ops:*` scope.
- **Read (0.3.1).** `getOpsTenant` answers the tenant as the console (#259) and the status panel (#296) show it, so a page can show the state instead of the last action's answer: `tenant_id`, `name`, `tier`, `state` (`active` / `suspended`), `process` (`shared` / `own`, from the tier), `node_id` (the owning node, or `null` while no route entry exists), `pinned_node` (the node an operator move or a failover pinned the tenant to, or `null`; section 16 FO4), `moving` (`true` while a microVM move is in progress, with `moving_since`), `microvm_at` (when a microVM move last succeeded, or `null`), `replication` (one entry per database of the tenant, section 3, with the fields the owning node last reported: `database`, `replication`, `state`, `replica`, `last_sync_at`, `lag_seconds`, `reported_at`, and `stale: true` when the report is older than two heartbeats; the full report per app is `getBackups`), and `actions`: the last five operator actions on the tenant, newest first, each `{ audit_id, at, action, operator, reason, result }` from the audit rows of section 17 (`operator` in the account id form of section 2; `result` the audit row's result, for example `changed`, `unchanged`, `moved`, `restore_failed`, `hook_failed`). The read is served from Postgres only (no node call), so it never blocks on a node and never answers 503. It is audited as `getOpsTenant`.
- **Break-glass (0.4).** An operator reads a tenant's data only through `impersonateTenant` (`docs/24-threat-model.md` G, "Operator reads tenant data"; the procedure is `ops/security/access-review.md`). The request is `{ "reason" }` (10 to 500 characters, as below) and optionally `scopes`, a subset of the tenant scopes `apps:read`, `logs:read`, `secrets:read` (names only), default all three; no write scope can be asked for in 0.4. The answer (201, `Impersonation`) is `{ impersonation_id, tenant_id, operator, reason, scopes, started_at, expires_at, ended_at, token }`: `token` is a `renox_pat_` tenant token with those scopes, bound to the impersonation, returned once, and valid until `expires_at` = `started_at` + 60 minutes (the **time box**; it is not extended, a new impersonation needs a new reason). The dashboard signs in with it as with any token (D23) and shows a banner while the token is an impersonation (`getAccount`/`getMfa` are not reachable with it; it has no user). Every request made with it is audited with actor `operator:<operator id>` and `impersonation_id`, and the tenant's audit trail shows those rows as the operator's, never as a member's. `endImpersonation` revokes the token at once; the time box revokes it at `expires_at` and writes the end row with actor `platform`. The tenant **owner is emailed** at start (operator, reason, `expires_at`) and at end (`ended_by`, the number of requests made); a failed email is retried and never blocks the start. One active impersonation per operator and tenant (409 otherwise). `getOpsTenant.actions[]` (still at most five) lists every active impersonation first, as `{ action: "impersonateTenant", result: "active", impersonation_id, expires_at, … }`, then the most recent other actions; an ended one appears like any other action with `result` `ended`.
- **Reason.** Every request carries `reason`, 10 to 500 characters (400 `RENOX_VALIDATION` otherwise), kept in the audit row with the operator's id and the result, so the break-glass rules of #121 can build on it. Every action also writes one `source: platform` log line for the tenant (`fields.kind` `tier` or `move`), without the reason.
- **Tier.** `{ "tier": "free" | "paid", "reason" }` records the tier and republishes every route entry of the tenant in one delta with the new `tier` and `process` (`own` for `paid`, `shared` for `free`), so the node's supervisor places the tenant without a config edit (#254). An unchanged tier answers 200 with `changed: false` and publishes nothing.
- **Move to a node.** `{ "target": "node", "node_id", "reason" }` runs the move of FO3 and FO4 with that node as the only candidate (`reason: move` in the restore request): restore on the target, then the delta, then the old node drains. A target that is unhealthy, full, or the current owner is 409 `RENOX_CONFLICT`; a failed restore leaves the tenant where it is (503 `RENOX_BACKUP_UNAVAILABLE`). An operator-pinned owner overrides the rendezvous assignment of section 7 until the pin is cleared by another move.
- **Move to a microVM.** `{ "target": "microvm", "reason" }` marks the tenant `moving`, calls the owning node's `nodeMoveTenant`, and answers the hook's exit code as `hook_exit_code`. The node runs its `[process] microvm_hook` with the tenant id and the file path (#259); in 0.3 the hook is a documented stub that exits 75. While the tenant is `moving`, its requests at the node answer 503 `RENOX_TENANT_MOVING` and the API refuses another tier change, move, export or import with the same code. Exit 0 records the tenant as moved; anything else ends `moving` and the tenant serves where it was.

## 18. Account and second factors (0.4)

The account endpoints that the CLI's `renox login` and the dashboard's sign-in and security pages use, as `control/api` implements them (#113, `src/auth/accounts.ts`; #293, `src/auth/mfa.ts`). Nothing in their behaviour is new in 0.4 except the **user token rule** below. The other account endpoints (sign-up, email verification, password reset, sessions, invitations, the team) stay in `control/api/README.md`, "Account endpoints".

| Operation | Path | Caller | Audit row | Errors |
| --- | --- | --- | --- | --- |
| `login` | `POST /v1/account/login` | anyone (login buckets per IP and per address) | `login`: user, session | 400, 401 (unknown address and wrong password alike), 404 (`tenant_id` the user is not a member of), 429 |
| `logout` | `POST /v1/account/logout` | session | `logout`: user, session | 401 |
| `startDeviceLogin` | `POST /v1/account/device` | anyone | `startDeviceLogin` | 400, 429 |
| `pollDeviceLogin` | `POST /v1/account/device/token` | anyone holding the device code | `pollDeviceLogin`: token, tenant, user (on 201) | 400, 404 (unknown, used or expired code), 429 |
| `approveDeviceLogin` | `POST /v1/account/device/approve` | session with `tokens:write` (a token is refused: a person approves) | `approveDeviceLogin`: device | 400, 401, 403, 404 |
| `getMfa` | `GET /v1/account/mfa` | signed-in user | none (read) | 401 |
| `startTotp`, `confirmTotp` | `POST /v1/account/mfa/totp`, `…/totp/confirm` | signed-in user | user | 400, 401, 403 (`step_up_required` when replacing a factor), 409 (TOTP already set up), 429 |
| `passkeyOptions`, `registerPasskey` | `POST /v1/account/mfa/passkeys/options`, `…/passkeys` | signed-in user | user (on registration) | 400, 401, 403 |
| `mfaChallenge` | `POST /v1/account/mfa/challenge` | signed-in user | none | 401, 404 (no passkey) |
| `verifyMfa` | `POST /v1/account/mfa/verify` | signed-in user | `verifyMfa`: user, method | 400, 401 (`details: [{ field: "mfa", reason: "invalid" }]`), 429 |
| `regenerateRecoveryCodes` | `POST /v1/account/mfa/recovery-codes` | signed-in user, stepped up | user | 401, 403, 409 (no factor) |
| `disableMfa` | `POST /v1/account/mfa/disable` | signed-in user | user | 400, 401, 429 |
| `setTeamMfaRequired` | `POST /v1/team/mfa-required` | `team:write` (session), stepped up | tenant, `required` | 400, 401, 403 |

- **Login.** `{ email, password, tenant_id? }` answers 200 `{ user_id, email, email_verified, tenant_id, role, session_id, expires_at, csrf, mfa }`, sets the `__Host-renox_session` cookie, and sends a new-device notice the first time a browser family signs in. `mfa` is the **session state**: `null` (the session is complete), `verify` (the user has a factor: `verifyMfa` next) or `enrol` (an owner or admin of any team, or a member of a team with `mfa_required`, past the grace period of `MFA_GRACE_DAYS` (14 days, *proposed*) after sign-up without a factor: set one up first).
- **Held sessions.** While the session state is `verify` or `enrol`, the session reaches only the operations of this section's MFA rows and `logout`; every other request is 401 `RENOX_UNAUTHENTICATED` with `details: [{ field: "mfa", reason: "required" }]` (state `verify`) or `[{ field: "mfa", reason: "enrol" }]` (state `enrol`). `verifyMfa` and the first factor's confirmation clear the state.
- **Factors.** TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step; a code works once), passkeys (WebAuthn, ES256 and RS256, the relying party the dashboard's host), and ten single-use recovery codes, answered once when the first factor is confirmed and by `regenerateRecoveryCodes`, which invalidates the old set. The TOTP secret is sealed at rest. Adding a factor and turning two-step verification off each send the account a notice. `disableMfa` needs `{ password, code }` (a current TOTP or recovery code). Verification attempts take from the login bucket of the address (429).
- **Step-up.** For a user with a factor, a **session** needs a verification within the last 15 minutes for: `putSecret`, `deleteSecret`, `bumpSecrets`; `createToken`, `revokeToken`, `approveDeviceLogin`; `changeMemberRole`, `removeMember`, `proposeOwnerTransfer` (README); `setTeamMfaRequired`, `regenerateRecoveryCodes`; and replacing a factor (`startTotp` and `passkeyOptions` when one is enrolled). Otherwise 403 `RENOX_TOKEN_SCOPE` with `details: [{ field: "mfa", reason: "step_up_required" }]`; the client verifies (`mfaChallenge`, `verifyMfa`) and retries the original request.
- **User token rule (0.4).** The MFA operations of this section (`getMfa` to `disableMfa`) also accept `Authorization: Bearer renox_pat_…` of a token **a user created** (`renox login`, the dashboard), acting for that user, so the dashboard, which signs in with the user's own token (D23), can show a security page. A token without a user (a bootstrap token, an impersonation token of section 17) is 401. With a token there is no session state: `getMfa.session_state` is `null`, and `verified_at` and the step-up window are kept **per token** (a verification made with the token counts for that token only), so `regenerateRecoveryCodes` with a token needs a `verifyMfa` with the same token in the last 15 minutes. The other stepped-up operations keep the rule of #293 for tokens (a token is a credential of its own, created by a stepped-up session, and is not stepped up again). `setTeamMfaRequired` and `approveDeviceLogin` stay session only. `logout` with a token is 401: a token is revoked with `revokeToken`.

## Open

1. **Presigned uploads.** Version 0 uploads through the API (100 MiB cap). A presigned direct-to-storage upload with a `POST …/deployments/{hash}/complete` step can be added as a minor change if uploads become a bottleneck (B15, #60).
2. **Front door.** Each node serves only the tenants assigned to it (section 7). How a request for `<app>.renox.app` reaches the owning node (DNS per tenant, an L4 balancer that hashes on SNI, or forwarding between nodes) is not decided; F3 runs one node per region, where the question does not arise.
3. **Preview hosts.** `<app>-<first 12 hex of the hash>.renox.app` for `validated` and `superseded` deployments is not published in version 0: a preview would run code against a schema its migrations have not reached. Revisit with a read-only database mode.
4. **Node authentication.** Bearer node tokens over TLS. mTLS with per-node certificates (#120 key hierarchy) is the stronger option for F6.
5. **Internal tenants.** Closed (0.3.1) by ADR D23 (`docs/13-decisions.md`, "D23 — Internal tenants reach the control API over the public path", #164), option (a): the dashboard tenant reaches this API over its public hostname with a scoped tenant token held in `ctx.secrets`, or the signed-in user's own credential. There is no `internal` field in `route_entry`, no exemption from the tenant `fetch` rules and no `ctx.platform` op; nothing in this contract changes.
6. **Rate-limit numbers** in section 2 are proposals for #113.
7. **Probe pass rule.** "Any status below 500" (section 6) differs from #96's "non-2xx fails". If tenants want a stricter check, a manifest `healthcheck` route (reserved) can require 2xx.
8. **Log retention and volume** (7 days, the per-tenant volume limit of `ops.md` section 4) stay proposals. `streamLogs` is served from the in-memory store until durable logs exist (#223); client error groups and their retention follow the same 7 days (#128).
9. **A `logs:write` scope.** Changing a group's status uses `apps:write` because adding a scope changes the matrix of section 2.1 and the token pattern. If teams want viewers' tokens to triage errors without `apps:write`, a `logs:write` scope is a minor change.
10. **Node listener authentication.** 0.3 uses a callback bearer per registration over TLS on the private network. Per-node mTLS (Open 4, #120) would replace both the node token and the callback token.
11. **In-place restore.** 0.3 restores only into a new app, so a mistaken restore never overwrites live data. An in-place restore (the operator action of #259 may add it) needs a read-only window and a second confirmation; it would be `target: in_place`, a minor change.
12. **Column masking on export.** `exportBackup` returns the whole file (`masking: none`). Masking columns named in `renox.toml` is F7, with the `admin` module; it adds an optional request field.
13. **Databases per app.** Apps of one tenant share one file unless they are staging apps or restores (section 3). Whether every app should get its own file by default is for the owner to decide with the replica ADR (#256); changing the default would be breaking for tenants with several apps.
14. **Synchronous replica.** FO1–FO6 restore from Litestream for every tier. The paid tier's near-zero RPO (`docs/06-data.md`) needs the replica that #256 measures; its promotion rule would be FO7.
15. **Impersonation writes.** 0.4 allows only read scopes under break-glass. A write scope (an operator fixing a tenant's data) needs a second operator's approval and is a minor change if the tabletop of #121 shows it is needed.
16. **Erasure of backups held by the store's versioning.** Section 3 relies on the bucket lifecycle (`ops/terraform`) for object versions; an erasure that also deletes every noncurrent version at once needs the delete-versions permission on the API's role, which the owner decides with #309.

## Changelog

| Version | Issue | Changes |
| --- | --- | --- |
| 0 | #50 | First version (F3): authentication and scopes, apps, upload and T1–T8, deployment states, activation and rollback, nodes and the route-table messages, secrets, domains and certificates, logs and meters, error codes |
| 0.1 | #184 | `GET /v1/apps/{app}/usage` (section 11, #56); bundle-hygiene rule ids H1 and H2 in `violations` (section 4, #115); `code/` is scanned for secrets by the CLI only (section 4); session callers, roles, the permission matrix and the operation table (section 2.1, #113) |
| 0.2 | #222 | Browser error groups: `listClientErrors`, `getClientError`, `setClientErrorStatus` and the frame, group and event shapes (section 11.1); `client_events` (`used_today`, `daily_cap`, `warning`) in the usage answer; `fields.fingerprint` on `source: client` lines of `streamLogs` and the client cap rule (section 11); Open 5 resolved by D23, Open 8 and 9 |
| 0.3 | #251 | Backups (section 14: `getBackups`, `exportBackup`, `restoreBackup`, `importDatabase`), staging apps and databases (section 3), the node listener and its messages (section 15, `schemas/node-listener.yaml`, `node_register.listen_url`, `node_registered.callback_token`), failover rules FO1–FO6 (section 16), `process` and `database` on route entries (section 8), operator actions and the `ops:write` scope (section 17), `source: platform` log lines (section 11), four error codes (section 12), Open 10–14 |
| 0.4 | #303 | Minor. Section 18: the account and MFA endpoints (`login`, `logout`, the device flow, `getMfa`, TOTP, passkeys, `mfaChallenge`, `verifyMfa`, recovery codes, `disableMfa`, `setTeamMfaRequired`), the session states `verify` and `enrol`, `step_up_required` and the stepped-up operations, a user token accepted on the MFA endpoints. Section 3: `getTenant`, `deleteTenant` and the `erasure` state machine. Section 17: `impersonateTenant`, `endImpersonation`, the scope `ops:impersonate`, active impersonations in `getOpsTenant.actions[]`. Section 7: optional `disk` on `heartbeat`, `getNode`. Section 11: optional `latency_p50_ms`, `latency_p95_ms`, `realtime_conn_seconds`, `realtime_messages` on `UsageHour`. Section 2: the reach of an `ops:read`-only token. Open 15–16 |
| 0.3.1 | #273 | Patch, no new behaviour. Section 11: `fields.frames` on a server line with a stack (#261). Section 2 and `TokenCreated.token`: `renox_op_` tokens of operator accounts (`^renox_(pat\|op)_`); the operator id form `operator` or `acct_<ulid>` everywhere this contract names an operator (`OperatorId`), `usr_<ulid>` staying internal. Section 17: `GET /v1/ops/tenants/{tenant_id}` (`getOpsTenant`) with the new scope `ops:read`, granted by `ops:write`, audited as a read; `OpsTenant` in the OpenAPI file. Open 5 closed by D23 |
