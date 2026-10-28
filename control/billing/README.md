# control/billing

Billing v0 (P14, #56): the control plane turns meter records (`docs/contracts/meter.md`) into hourly usage, shows it to tenants, and flags tenants over their tier's quota. F3 produces the data, not invoices; suspension on quota is F7.

| Piece | Where | What |
| --- | --- | --- |
| Ingestion | `POST /v1/ingest/meters` in `control/api/src/ingest/routes.ts`, logic in `src/ingest.ts` | The HTTP sink of `meter.md` section 5. Node token; `node_id` must be the token's node; every record must name a deployment of its tenant; one statement inserts the batch into `meters_raw`, de-duplicated on `request_id`; 202 `{ accepted, duplicates }` |
| Hourly rollup | `src/rollup.ts`, run by `src/main.ts` | Recomputes whole UTC hours of `meters_raw` into `meters_hourly` (one row per tenant, deployment, hour). Idempotent; each scheduled run covers the last 48 hours plus the current one, so retries and dead-letter replays within 48 h are counted |
| Usage view | `GET /v1/apps/{app}/usage?from=&to=` in `control/api/src/ingest/routes.ts`, reads in `src/usage.ts` | Hour by hour usage of one app (default: the current UTC month), the total, and the tenant's quota state. Scope `apps:read` |
| Quota signal | `src/quota.ts` | Monthly quotas per tier (proposals); the job logs `tenant over quota` per tenant and dimension. Nothing is suspended |
| Unit-cost report | `src/unit-cost.ts`, results in `reports/` | Cost per CPU-ms and per request from file-sink meter records and the node cost hypotheses of `docs/01-business.md` |

The tables `meters_raw` and `meters_hourly` are created by `control/api/migrations/0001_init.sql`; billing owns no migrations.

## Rollup columns

From `meter.md` section 7:

| Column | Meaning |
| --- | --- |
| `requests` | Records with `status` other than `busy` (busy rejections are not charged) |
| `cpu_ms` | Billed CPU: `cpu_ms + render_ms` (absent `render_ms` = 0) |
| `egress_bytes`, `fetch_sent_bytes` | Kept apart; billed egress is their sum |
| `wall_ms`, `db_ms`, `db_rows`, `render_fuel` | Plain sums, for limits and dashboards |

A deployment hash belongs to one app (the manifest names its app, rule V3, and app names are global), so per-app usage joins `meters_hourly` to `deployments` on the hash.

## Quotas (proposals)

| Tier | Requests / month | CPU-ms / month | Egress / month |
| --- | --- | --- | --- |
| free | 3,000,000 | 30,000,000 | 10 GiB |
| paid | 100,000,000 | 1,000,000,000 | 1 TiB (abuse signal; paid is usage-billed) |

Set from the unit-cost report once its numbers come from `node-small` (#158) and CPU attribution is exact (#155); see the findings in `reports/2026-10-28-unit-cost.md`.

## Run

```sh
CONTROL_DATABASE_URL=postgres://renox:renox-dev@localhost:5432/renox bun control/billing/src/main.ts           # every hour
CONTROL_DATABASE_URL=... bun control/billing/src/main.ts --once                                               # one pass
CONTROL_DATABASE_URL=... bun control/billing/src/main.ts --from 1793318400000 --to 1793404800000             # backfill
bun control/billing/src/unit-cost.ts --tenant t_shop --throughput 21094 <data_dir>/meters                    # unit cost
```

Run one job process per control plane: two at once write the same rows with the same values, which is harmless but wasted work.

## Tests

`bun test` in this directory, on an in-process PGlite with the control API's migrations. `control/api/tests/ingest.test.ts` covers the two endpoints.
