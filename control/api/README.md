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
| `CONTROL_LISTEN_PORT` | `8787` | HTTP port |
| `CONTROL_DATABASE_URL` | `pglite:memory` | `postgres://…`, `pglite:memory`, or `pglite:<dir>` |
| `CONTROL_OPERATOR_TOKEN_SHA256` | unset (operator endpoints answer 401) | SHA-256 hex of the `renox_op_…` token |
| `CONTROL_MASTER_KEY` | unset (secret endpoints disabled) | Base64 of the 32-byte master key that wraps the per-tenant data keys |
| `CONTROL_PLATFORM_DOMAIN` | `renox.app` | App hostnames are `<app>.<domain>` |
| `CONTROL_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | unset, `renox-artifacts`, `me-central-1` | Object storage |
| `CONTROL_DASHBOARD_URL` | `https://dashboard.renox.app` | Base of the links in account emails |
| `CONTROL_MAIL_OUTBOX_DIR` | unset (account emails are dropped, with a warning) | Writes each account email to a file there (local development) |

The start sequence is: open the database, apply the migrations in `migrations/`, then serve. A migration file that changed after it was applied stops the start.

## Layout

| Path | What |
| --- | --- |
| `src/app.ts` | The Hono app: request id, access log, error handling, route modules |
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
| `src/ingest/` | Meter ingestion and the per-app usage view (#56; rollup and quotas in `control/billing`) |
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

### GitHub secret scanning for `renox_pat_`

Tokens have a fixed prefix so a leaked one can be found. Registering it with GitHub's secret scanning partner program is an operations task; the steps:

1. Apply at <https://docs.github.com/en/code-security/secret-scanning/secret-scanning-partnership-program/secret-scanning-partner-program> with the pattern `renox_pat_[a-z2-7]{32}` (and `renox_node_[a-z2-7]{32}`), a sample token, and the alert endpoint URL.
2. Run the alert endpoint: it receives batches of `{token, type, url, source}`, verifies GitHub's signature (`Github-Public-Key-Identifier`, `Github-Public-Key-Signature` against the published keys), looks each token up by SHA-256, revokes it, writes an audit row (`actor: github-secret-scanning`), and emails the owner and the user who created it.
3. Answer with the token-checking feedback GitHub asks for (`true_positive` / `false_positive`).

The endpoint is not built yet; it needs no change to the token format.

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

## Logs

One JSON object per line on stdout: `ts`, `level`, `msg`, and fields. Each request writes one line: `request_id`, `method`, `route` (the pattern, not the URL), `action` (the operationId), `status`, `actor`, and `ms`. Bodies, headers and secret values are never logged. Any string shaped like a Renox token is masked before a line is written.
