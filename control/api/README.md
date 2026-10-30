# control/api

The Renox control plane's deploy API: Bun + Hono, Postgres, S3-compatible object storage. The contract is [`docs/contracts/deploy-api.md`](../../docs/contracts/deploy-api.md) with [`schemas/deploy-api.yaml`](../../docs/contracts/schemas/deploy-api.yaml); request bodies, worker messages and the state machines are loaded from those files (`src/contract.ts`), so the API never keeps a second copy of them.

## Run

```sh
docker compose -f control/docker-compose.yml up -d        # Postgres 16 + MinIO + the artifact bucket
CONTROL_DATABASE_URL=postgres://renox:renox-dev@localhost:5432/renox \
CONTROL_S3_ENDPOINT=http://localhost:9000 \
CONTROL_S3_ACCESS_KEY_ID=renox CONTROL_S3_SECRET_ACCESS_KEY=renox-dev-minio \
CONTROL_OPERATOR_TOKEN_SHA256=$(printf %s "$RENOX_OP_TOKEN" | sha256sum | cut -c1-64) \
CONTROL_MASTER_KEY=$(openssl rand -base64 32) \
bun control/api/src/main.ts
```

Without a database URL the API runs on an in-memory PGlite, and without `CONTROL_S3_ENDPOINT` on an in-memory object store. Both are for quick local runs only.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTROL_LISTEN_PORT` | `8787` | Port of the public listener (tenant, account, operator, MCP endpoints) |
| `CONTROL_NODE_LISTEN_HOST` | `0.0.0.0` | Address the node listener binds; set it to the private address only nodes reach |
| `CONTROL_NODE_LISTEN_PORT` | `8788` | Port of the node listener (`/v1/nodes/*`, `/v1/ingest/*`, `/v1/healthz`); must differ from `CONTROL_LISTEN_PORT` |
| `CONTROL_DATABASE_URL` | `pglite:memory` | `postgres://…`, `pglite:memory`, or `pglite:<dir>` |
| `CONTROL_OPERATOR_TOKEN_SHA256` | unset (operator endpoints answer 401) | SHA-256 hex of the `renox_op_…` token |
| `CONTROL_MASTER_KEY` | unset (secret endpoints disabled) | Base64 of the 32-byte master key that wraps the per-tenant data keys |
| `CONTROL_PLATFORM_DOMAIN` | `renox.app` | App hostnames are `<app>.<domain>` |
| `CONTROL_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | unset, `renox-artifacts`, `me-central-1` | Object storage |
| `CONTROL_DASHBOARD_URL` | `https://dashboard.renox.app` | Base of the links in account emails |
| `CONTROL_MAIL_OUTBOX_DIR` | unset (account emails are dropped, with a warning) | Writes each account email to a file there (local development) |

The start sequence is: open the database, apply the migrations in `migrations/`, then serve. A migration file that changed after it was applied stops the start.

### Two listeners: the node-facing surface stays off the public edge (ADR D23, #218)

`main.ts` serves the API as two surfaces (`createApp(deps, [], surface)` in `src/app.ts`):

| Listener | Serves | Who reaches it |
| --- | --- | --- |
| Public, `CONTROL_LISTEN_PORT` | Everything except `/v1/nodes/*` and `/v1/ingest/*`, which answer `404 RENOX_NOT_FOUND` before any handler or auth middleware runs | The internet: the CLI, the MCP server, browsers, and internal tenants such as the dashboard (D23) |
| Node, `CONTROL_NODE_LISTEN_HOST`:`CONTROL_NODE_LISTEN_PORT` | Only `/v1/nodes/*`, `/v1/ingest/*` (all `renox_node_` tokens: route tables, secret bundles, artifacts, certificates, prepare results, meters, logs) and `/v1/healthz`; everything else is 404 | Worker nodes only |

The node paths are matched lower-cased and with repeated slashes collapsed, on the path the router uses. Deployment rules:

- The public edge (load balancer, reverse proxy, `api.<platform domain>`) forwards to the public listener only. It never forwards to the node listener, whatever the host or path.
- The node listener binds a private address, or an address of its own that only the nodes' network reaches. Each node's `[control] url` points at it, and the address is in that node's `fetch_blocked_addresses` unless it is in a private range already. A controlled worker refuses to start otherwise (`crates/renox-cell/src/worker.rs`).
- The public listener's address is never listed in `fetch_blocked_addresses` and never exempt: internal tenants reach it like any internet client.

## Layout

| Path | What |
| --- | --- |
| `src/app.ts` | The Hono app: request id, access log, error handling, route modules; the public and node surfaces |
| `src/contract.ts` | Schemas and state machines from `docs/contracts` (Ajv, JSON Schema 2020-12) |
| `src/auth/` | Token values and hashes, scopes, sessions, passwords, buckets, account emails; the tenant, account, node and operator middleware; the account routes (#113) |
| `src/tenancy/` | Roles and the permission matrix, the operation table, `withTenant`, the team routes (#113) |
| `src/audit.ts` | One append-only audit row per mutating request |
| `src/db/` | The `Db` interface; Postgres (Bun's client) and PGlite adapters; the migration runner |
| `src/storage/` | The object store (S3 via Bun's client; in-memory for tests) |
| `src/apps/`, `src/tokens/`, `src/tenants/` | Apps, tenant tokens, operator endpoints |
| `src/deployments/` | Upload, validation and storage (#52) |
| `src/routes/`, `src/workers/` | Activation, rollback, the route table, nodes (#53) |
| `src/secrets/` | Secrets (#54) |
| `src/ingest/` | Meter ingestion and the per-app usage view (#56; rollup and quotas in `control/billing`); log ingestion, the log store and the daily client-event counter (`logs.ts`, #199, #223) |
| `src/logs/` | `GET /v1/apps/{app}/logs` as Server-Sent Events (`stream.ts`, #223); browser error groups: ingestion, fingerprints, the three `client-errors` routes (`client-events.ts`, `grouping.ts`, #128) |
| `src/sourcemaps/` | Symbolication of browser frames against the private sourcemaps of a deployment (#128) |
| `migrations/` | Forward-only SQL, `NNNN_<name>.sql` |

## Accounts, roles, and tenant scoping (#113)

A tenant request is authenticated as one principal bound to one tenant (docs/24-threat-model.md E):

- **Token** (`Authorization: Bearer renox_pat_…`): its scopes; when a user created it (dashboard, `renox login`, or a token of theirs), also at most that user's current role, and it stops working when the user leaves the tenant. The operator's bootstrap token has no user.
- **Session** (`__Host-renox_session` cookie, `HttpOnly`, `Secure`, `SameSite=Strict`): the user's role in the tenant the session is bound to (`POST /v1/account/tenant` switches). Absolute expiry 30 days, idle expiry 24 hours. Mutating requests also carry `X-Renox-CSRF` (from the login response or `GET /v1/account`).

The permission each operation needs is `ROUTE_PERMISSIONS` in `src/tenancy/roles.ts`; for the deploy API it equals `x-renox-scope` in the OpenAPI file (a test checks). Every statement of a tenant request goes through `withTenant(db, principal)` (`src/tenancy/scope.ts`), which refuses a statement not bound to the principal's tenant; `assertScoped` fails any test in which a tenant request touched the raw database, and `test/idor/` calls every registered route with another tenant's ids (404 expected; a route with no case fails the suite).

### Roles

The matrix (source: `MATRIX` in `src/tenancy/roles.ts`; a test checks this table against it). The five permissions below the line are held by signed-in users only, never by a token. Ownership moves only by an owner transfer, which the owner proposes and the new owner accepts.

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
| `registry:read` | yes | yes | yes | yes |
| `registry:publish` | yes | yes | — | — |
| `billing` | yes | — | — | — |
| `apps:delete` | yes | yes | — | — |
| `tenant:delete` | yes | — | — | — |

`deploy` covers upload, sourcemaps, activate and rollback; `secrets:read` lists names only. A developer's `tokens:write` lists and revokes their own tokens; owners and admins see all of the tenant's. Deploying needs a verified email address.

### Account endpoints

Not yet in `docs/contracts/deploy-api.md` (a contract issue adds them); request and response bodies are JSON.

| Route | Who | What |
| --- | --- | --- |
| `POST /v1/account/signup` | anyone | `{email, password, tenant_id?, tenant_name?}` → 202 whether or not the address has an account; sends the verification link (24 h) |
| `POST /v1/account/verify` | anyone | `{token}` from the link; single use |
| `POST /v1/account/verify/resend` | session | a new link |
| `POST /v1/account/login` | anyone | `{email, password, tenant_id?}` → session cookie, CSRF value; 401 for unknown address and wrong password alike; buckets per address and per email; new-device email |
| `POST /v1/account/logout` | session | ends this session |
| `POST /v1/account/password-reset`, `/confirm` | anyone | `{email}` → 202; `{token, password}` → new password, link used once (1 h), every session ended |
| `GET /v1/account`, `POST /v1/account/tenant` | session | the user, memberships, current tenant; switch tenant |
| `GET /v1/account/sessions`, `DELETE …/{session_id}`, `POST …/revoke-all` | session | active sessions; sign out one; sign out everywhere |
| `POST /v1/account/invitations/accept` | session | `{token}` from the invitation email; the address must match and be verified |
| `POST /v1/account/device`, `/device/token`, `/device/approve` | anyone; anyone; session with `tokens:write` | the `renox login` device flow: start, poll (202 pending, 201 token), approve `{user_code, scopes?}` |
| `GET /v1/team/members`, `PUT|DELETE /v1/team/members/{user_id}` | `team:read`; `team:write` | members; change role (not to or from owner); remove |
| `POST|GET /v1/team/invitations`, `DELETE …/{invitation_id}` | `team:write`; `team:read`; `team:write` | invite `{email, role}` (7 days); list; revoke |
| `POST|DELETE /v1/team/owner-transfer`, `POST …/accept` | owner; owner; the proposed user | owner transfer (7 days) |

Passwords are argon2id (19 MiB, 2 iterations), 10 to 256 bytes. Account emails go through a `Mailer`; only a file outbox exists so far.

### Second factors (#293)

`src/auth/mfa.ts`: TOTP and passkeys for control-plane accounts, using the SDK's primitives (`sdk/src/totp.ts`, `sdk/src/webauthn.ts`), with ten single-use recovery codes. These endpoints are not in `docs/contracts/deploy-api.md` yet, like the other account endpoints.

| Route | Who | What |
| --- | --- | --- |
| `GET /v1/account/mfa` | session | `{totp, passkeys, recovery_left, enrolled, required, grace_until, session_state, verified_at}` |
| `POST /v1/account/mfa/totp`, `POST …/totp/confirm` | session | Start: `{secret, otpauth_uri}`; the secret is sealed at rest under a key derived from `CONTROL_MASTER_KEY`. Confirm: `{code}`. Answers the recovery codes once, when there are none yet |
| `POST /v1/account/mfa/passkeys/options`, `POST …/passkeys` | session | WebAuthn registration options; `{client_data, attestation_object, name?}` |
| `POST /v1/account/mfa/challenge` | session | Assertion options for the user's passkeys |
| `POST /v1/account/mfa/verify` | session | `{method: "totp" \| "recovery" \| "passkey", code \| credential_id + client_data + authenticator_data + signature}`. On success the session counts as verified now (`mfa_at`). Attempts take from the login bucket of the address. A TOTP code works once |
| `POST /v1/account/mfa/recovery-codes` | session, stepped up | A new set; the old one stops working |
| `POST /v1/account/mfa/disable` | session | `{password, code}`: the password and a current TOTP or recovery code |
| `POST /v1/team/mfa-required` | `team:write`, stepped up | `{required}`: every member of the team needs a factor, once their grace period has passed |

- **Sign-in.** For a user with a factor, `POST /v1/account/login` answers `mfa: "verify"`. Its session reaches only the MFA endpoints and logout until `verify` passes; any other request is 401 with `details: [{field: "mfa", reason: "required"}]`.
- **Grace period.** An owner or admin of any team, or a member of a team that set `mfa_required`, who has no factor `MFA_GRACE_DAYS` (default 14) after signing up, starts in `mfa: "enrol"` (`reason: "enrol"`) until they set one up.
- **Step-up.** For a user with a factor, a session needs a verification in the last 15 minutes to:
  - put, delete or bump secrets;
  - create or revoke tokens, or approve a device login;
  - change a member's role, remove a member, or propose an owner transfer;
  - change the team requirement, or make new recovery codes.

  Otherwise the request is 403 `details: [{field: "mfa", reason: "step_up_required"}]`. Tokens are not stepped up: a token is a credential of its own, created by a session.
- **Notices.** Adding a factor and turning two-step verification off each send the account a notice (mail kind `new_device`).
- **Passkey relying party.** It is the dashboard's host by default (`CONTROL_DASHBOARD_URL`); `MFA_RP_ID` and `MFA_ORIGIN` override it.
- **Tests.** `tests/mfa.test.ts`; the IDOR matrix (`test/idor/idor.test.ts`) has a case for every MFA route.

### GitHub secret scanning for `renox_pat_`

Tokens have a fixed prefix so a leaked one can be found. Registering it with GitHub's secret scanning partner program is an operations task; the steps:

1. Apply at <https://docs.github.com/en/code-security/secret-scanning/secret-scanning-partnership-program/secret-scanning-partner-program> with the pattern `renox_pat_[a-z2-7]{32}` (and `renox_node_[a-z2-7]{32}`), a sample token, and the alert endpoint URL.
2. Run the alert endpoint: it receives batches of `{token, type, url, source}`, verifies GitHub's signature (`Github-Public-Key-Identifier`, `Github-Public-Key-Signature` against the published keys), looks each token up by SHA-256, revokes it, writes an audit row (`actor: github-secret-scanning`), and emails the owner and the user who created it.
3. Answer with the token-checking feedback GitHub asks for (`true_positive` / `false_positive`).

The endpoint is not built yet; it needs no change to the token format.

## Tenant erasure (#308)

`src/tenants/erasure.ts`: `GET /v1/tenants/{tenant_id}` (`getTenant`, the caller's own tenant with its `erasure`) and `DELETE /v1/tenants/{tenant_id}` (`deleteTenant`, the owner's session only, `{ confirm: "<tenant_id>" }`; deploy-api.md 0.4 section 3). The answer is 202 with the `pending` record; the steps run after the answer and every minute after that (`sweepErasures` in `main.ts`), each retried hourly until confirmed: `routes` (the tenant suspended, every route entry removed and published), `tokens` (revoked), `node_drop` (`nodeDropTenant` on every node with a listener), `exports` (objects and rows), `records` (apps, deployments, secrets, domains, client error groups, meters, permissions, reports). `done` sets `completed_at`, writes the platform audit row and emails the owner (`tenant_erased`); a step still failing 24 hours after the request makes it `failed` with that step and an `erasure_failed` alert row. What stays: the audit rows, the memberships and the tenant row (suspended) as the tombstone. 409 while the tenant is moving. Migration `0012_erasure.sql`.

**Exports with SSE-KMS.** `EXPORT_KMS_KEY_ID` set: `exportBackup` writes the export with `x-amz-server-side-encryption: aws:kms` and that key id (a SigV4-signed put, `src/storage/object-store.ts` `signedPut`, since Bun's S3 client has no SSE options); unset (local mode): a plain put and a warning at start. The export bucket refuses any other put (`ops/terraform/bucket.tf`, #309).

Not done yet (#308 stays open for them): deleting the database's Litestream generations in the replica store (the control plane holds no replica credentials; the node's drop stops the sidecar after the last frames), the dashboard settings page's delete action and state, the `bench/chaos/scenarios/erasure.ts` scenario (the chaos stack cannot run in the batch container, see #312).

## Break-glass, security.txt, operator tokens (#310)

- **Break-glass** (`src/ops/breakglass.ts`, deploy-api.md 0.4 section 17): `POST /v1/ops/tenants/{tenant_id}/impersonate` with `{ reason, scopes? }` needs an operator token created with `ops:impersonate` (alone or with `ops:read`, at most 1 day; the bootstrap token and `ops:write` never grant it). It answers a `renox_pat_` tenant token with read scopes only (`apps:read`, `logs:read`, `secrets:read` by default) that expires after 60 minutes; one active per operator and tenant (409). `DELETE …/impersonate/{impersonation_id}` ends it at once; `endExpiredImpersonations` (every 30 s in `main.ts`) ends it at the time box with an `endImpersonation` row by `platform`. The owner is emailed at start (operator, reason, end time) and at end (how, requests made). Every request with the token is audited with actor `operator:<acct_id>/<imp_id>` (`auditActor`, set in `src/auth/middleware.ts`). `getOpsTenant.actions[]` lists active impersonations first. Migration `0013_breakglass.sql`.
- **security.txt** (`src/well-known.ts`): `GET /.well-known/security.txt` (RFC 9116): `CONTROL_SECURITY_CONTACTS` (comma separated, default `mailto:security@renox.app`), `CONTROL_SECURITY_POLICY`, `Canonical` on `api.<platform domain>`, `Preferred-Languages: en, ar`, `Expires` 180 days ahead, as the gateway's file.
- **Operator tokens** (`src/tokens/routes.ts`): `createToken` from an account flagged `operator` accepts `["ops:write"]`, `["ops:read"]` (a read-only console token: `getOpsTenant`, `/v1/ops/metrics`), `["ops:impersonate"]` or `["ops:impersonate", "ops:read"]`, never a tenant scope.
- **Operator ids**: the audit rows of `setTenantTier` and `moveTenant` store the operator as `acct_<ulid>` (the wire form), never `usr_`.

Not done yet (#310 stays open for it): the operator console's break-glass form, the active list and the banner inside the impersonated session (`control/dashboard/pages/ops/**`).

## Module registry (#324)

deploy API 0.5 section 19, `src/registry/routes.ts`, migration `0017_registry.sql`.

- **Publishers.** `POST /v1/publishers` (name and an Ed25519 public key; `renox` and taken names are 409) and `POST /v1/publishers/{publisher}/keys` (add a key, revoke old ones). Both need `registry:publish`; another tenant's publisher is 404.
- **Versions.** `PUT /v1/registry/{publisher}/{name}/{version}` takes the module tree as a tar. The API recomputes the tree hash, checks `module.sig` against one of the publisher's unrevoked keys (MF15), validates `module.toml`, and stores the permission summary. A version is immutable: the same version twice is 409.
- **Reading.** `GET /v1/registry?q=` returns the newest version of each module. `GET …/{version}` and `…/{version}/tree` read one version; a disabled tree is 409 for downloads. `GET …/diff?from=&to=` returns the permissions added and removed, the new migrations, and the templates that changed.
- **Installs.** `GET /v1/apps/{app}/modules` lists installs. `POST` records one, and only with `approved` equal to the version's own request; any other approval is 409.
- **Disable.** `POST /v1/registry/disable` takes an operator token (`opsAuth`), a hash and a reason of 10 to 500 characters. It marks every installation of that tree and emails each tenant owner (`module_disabled`). `enabled: true` undoes it.
- **Audit and the dashboard.** Every call writes an audit row. The dashboard shows installs on the Modules page (`control/dashboard/pages/apps/[app]/modules`) and moderation on `/ops/registry`.
- **Tests.** `tests/registry.test.ts` and `control/dashboard/tests/modules.test.ts`.

## Tests

`bun test` in this directory. The tests run on one in-process PGlite (started once per test run, emptied before each test). `tests/postgres.test.ts` also checks the production adapter against a real server when `CONTROL_TEST_DATABASE_URL` is set; the compose stack creates `renox_test` for it:

```sh
CONTROL_TEST_DATABASE_URL=postgres://renox:renox-dev@localhost:5432/renox_test bun test
```

To run the whole suite on Postgres instead of PGlite, point `CONTROL_TEST_HARNESS_URL` at another empty database (its `public` schema is dropped and recreated). This catches driver differences that PGlite hides; for example, jsonb parameters are written `$n::text::jsonb` because Bun's client encodes a string bound to `$n::jsonb` a second time.

```sh
psql -h localhost -U renox -c 'create database renox_harness'
CONTROL_TEST_HARNESS_URL=postgres://renox:renox-dev@localhost:5432/renox_harness bun test
```

## Operator read and metrics (#296)

- `GET /v1/ops/tenants/{tenant_id}` (`getOpsTenant`, deploy-api.md 0.3.1 section 17, `src/ops/tenants.ts`): the tenant as the operator console's status panel shows it, from Postgres only. `replication` is what each database's owning node last answered to the API (`replication_reports`, written whenever `getBackups` reads a node's status; `stale` after two heartbeats); `actions` are the last five `setTenantTier` / `moveTenant` audit rows. Every read writes a `getOpsTenant` audit row with the operator, found or not. `ops:read` or `ops:write`; an `ops:read`-only token cannot be minted yet (`src/tokens/routes.ts` creates `ops:write` tokens only).
- `GET /v1/ops/metrics` (`src/ops/metrics.ts`): the control plane's Prometheus families (`renox_cp_*`: node health, heartbeat age, cells, tenants by tier and state, tenants moving, replication lag from the last reports, failovers, alert rows, deployments) for `ops/observability/prometheus.yml`. Same credential and scope as the read; no tenant id in any label, so a scrape is not audited (a refused credential is). Not a deploy API operation: listed in `test/idor/idor.test.ts` `EXTRA_ROUTES`.

Tests: `tests/ops-read.test.ts` (non-operators refused and audited, the 0.3.1 shape validated against `OpsTenant`, no node call, the read audited, a stale report; the metrics text and its refusals).

## Reading logs (`GET /v1/apps/{app}/logs`, #223)

`streamLogs` (`logs:read`) serves the lines `POST /v1/ingest/logs` stored, as SSE: `event: log`, `id: <ts>-<n>`, `data:` one `log_line` of the contract. `n` is the line's place in the tenant's ingestion order; it is what a reconnect resumes from.

| Query / header | Effect |
| --- | --- |
| none | The last 100 lines, then the stream closes |
| `since=<ms>` | The lines at or after it (at most 10,000), then closes |
| `source=all\|server\|client`, `deployment=<hash>` | Filters, applied before the last 100 are taken |
| `follow=true` | Stays open, sends new lines, `: keep-alive` every 15 s |
| `Last-Event-ID` | Only lines after that id (follow or not) |

A tenant holds at most **5** follow streams (`FOLLOW_STREAMS_PER_TENANT`); the sixth is 429 `RENOX_RATE_LIMITED` with `Retry-After`. A stream ends and frees its slot when the client disconnects. Another tenant's app is 404.

**The cap rule.** Lines with `source: client` (browser events) are not counted by the per-minute volume cap (1,000 lines free, 10,000 paid, then sampled); they count toward a per-tenant **daily** counter (`DailyClientCounter`, since 00:00 UTC) that the usage view reads for the 80 % warning (client-events.md section 7, #128). The store is in memory (`MemoryLogStore`, 7 days, 50,000 lines per tenant): lines do not survive a restart (deploy-api.md Open 8).

## Browser errors (`client-errors`, #128)

Client events arrive as log lines with `source: client` (client-events.md section 9). At ingestion (`POST /v1/ingest/logs`) each accepted one is assigned to a **group** by fingerprint (`src/logs/grouping.ts`: kind, top frame without content hashes, message without numbers and ids), stored in `client_error_groups` with counts per deployment (`client_error_deployments`) and the last 20 events (`client_error_events`; migration `0006`), and its line gets `fields.fingerprint` so the Logs page can link it. A grouping failure never fails the ingest. A `resolved` group that receives an event from a deployment created after the one active when it was resolved reopens with `regressed: true`.

| Route | Permission | |
| --- | --- | --- |
| `GET /v1/apps/{app}/client-errors` | `logs:read` | Groups, most recently seen first; `status`, `since`, `deployment`, `limit`, `cursor` |
| `GET /v1/apps/{app}/client-errors/{fingerprint}` | `logs:read` | The group and its last 20 events |
| `POST /v1/apps/{app}/client-errors/{fingerprint}` | `apps:write` | `{ "status": "open" \| "resolved" \| "ignored" }` |

**Symbolication** is done when a group or event is read, not stored: the raw frames are kept and `original` is looked up in the private map `public/<path>.map` (or `<path>.map`) of the event's deployment, from the tar `PUT …/deployments/{hash}/sourcemaps` stored under `sourcemaps/<tenant>/<hash>.tar` (`src/sourcemaps/symbolicate.ts`). No route serves a map; the original path is shown relative, without `..`. **Quota:** `GET /v1/apps/{app}/usage` reports `client_events { used_today, daily_cap, warning }` from the daily counter of the log ingest (warning from 80 % of 144,000 free / 1,440,000 paid, *proposed*).

## Logs

One JSON object per line on stdout: `ts`, `level`, `msg`, and fields. Each request writes one line: `request_id`, `method`, `route` (the pattern, not the URL), `action` (the operationId), `status`, `actor`, and `ms`. Bodies, headers and secret values are never logged. Any string shaped like a Renox token is masked before a line is written.
