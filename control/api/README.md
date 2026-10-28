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

The start sequence is: open the database, apply the migrations in `migrations/`, then serve. A migration file that changed after it was applied stops the start.

## Layout

| Path | What |
| --- | --- |
| `src/app.ts` | The Hono app: request id, access log, error handling, route modules |
| `src/contract.ts` | Schemas and state machines from `docs/contracts` (Ajv, JSON Schema 2020-12) |
| `src/auth/` | Token values and hashes, scopes, the tenant, node and operator middleware |
| `src/audit.ts` | One append-only audit row per mutating request |
| `src/db/` | The `Db` interface; Postgres (Bun's client) and PGlite adapters; the migration runner |
| `src/storage/` | The object store (S3 via Bun's client; in-memory for tests) |
| `src/apps/`, `src/tokens/`, `src/tenants/` | Apps, tenant tokens, operator endpoints |
| `src/deployments/` | Upload, validation and storage (#52) |
| `src/routes/`, `src/workers/` | Activation, rollback, the route table, nodes (#53) |
| `src/secrets/` | Secrets (#54) |
| `migrations/` | Forward-only SQL, `NNNN_<name>.sql` |

## Tests

`bun test` in this directory. The tests run on one in-process PGlite (started once per test run, emptied before each test). `tests/postgres.test.ts` also checks the production adapter against a real server when `CONTROL_TEST_DATABASE_URL` is set; the compose stack creates `renox_test` for it:

```sh
CONTROL_TEST_DATABASE_URL=postgres://renox:renox-dev@localhost:5432/renox_test bun test
```

## Logs

One JSON object per line on stdout: `ts`, `level`, `msg`, and fields. Each request writes one line: `request_id`, `method`, `route` (the pattern, not the URL), `action` (the operationId), `status`, `actor`, and `ms`. Bodies, headers and secret values are never logged. Any string shaped like a Renox token is masked before a line is written.
