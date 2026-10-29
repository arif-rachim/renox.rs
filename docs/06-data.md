# 06 — Data

Tenant data lives in SQLite, one file per tenant, on the same node as the tenant's isolate. Platform data (tenants, deployments, billing, audit) lives in Postgres. This split follows Cloudflare (D1 for tenants, internal Postgres) and Turso.

| Layer | Database | Reason |
| --- | --- | --- |
| Control plane | Postgres | Cross-tenant queries, analytics, billing transactions, mature tooling |
| Tenant data, default | SQLite per tenant (`rusqlite` / libSQL), WAL, Litestream to UAE-region object storage | File-level isolation, zero idle cost, microsecond latency, per-tenant backup, data stays in the UAE |
| Tenant data, higher tier | SQLite with a synchronous replica (libSQL / LiteFS) on a second node | Automatic failover, RPO near zero |
| Large tenants | Managed or bring-your-own Postgres | Heavy write load, hundreds of GB |

## Why SQLite per tenant

| Aspect | SQLite per tenant | Postgres schema per tenant |
| --- | --- | --- |
| Tenant isolation | One file per tenant; no query can cross | RLS/search_path; one bug = leak |
| Idle tenant cost | Zero (file closed) | Catalog bloat at tens of thousands of schemas |
| Query latency | Microseconds, in-process; N+1 in loaders is not fatal | Hundreds of µs–ms per round trip |
| Backup/restore per tenant | Copy file, point-in-time per tenant | Hard to restore a single tenant |
| Moving a tenant between nodes | Copy file | Dump/restore |
| Write concurrency | One writer per file (WAL: many readers) | High |
| Local development | Zero setup, same engine as production | Must run Postgres |

## Layout inside a tenant file

- **Table prefix per module**: `auth__users`, `billing__invoices`. SQLite has no schemas, and `ATTACH` across files is not atomic in WAL mode, so one file per tenant keeps cross-module transactions atomic.
- **Per-module permissions via `sqlite3_set_authorizer`**: Rust installs a callback per module connection that only allows `<module>__*` tables plus read access to views `<dep>__public_*` of declared dependencies. SQLite checks this when compiling each statement; no SQL parsing in Rust.
- **Platform tables in the tenant file**: `renox__migrations`, `renox__outbox`, `renox__sessions`, `renox__role_assignments`, `renox__audit`.
- **Migrations** per module, forward-only, expand/contract pattern. Checksums are recorded so old migration files cannot be changed silently.
- **DDL in a migration** runs under the module's authorizer with DDL allowed, on the module's own `<module>__*` objects only. A module may `create` and `drop` its tables, views and indexes, and run `alter table <module>__t` with `rename to`, `add column`, `rename column` and `drop column`, STRICT tables included. SQLite checks a table itself with a nested `pragma_quick_check` read while it alters it. That read is allowed only inside an `alter table` of the module's own table (#264). A `pragma` the module writes itself, `attach`, triggers, virtual tables and any object of another module or of the platform are refused.

```sql
-- modules/billing/migrations/001_init.sql
create table billing__invoices (
  id         text primary key,
  org_id     text not null references auth__orgs(id),
  user_id    text not null references auth__users(id),
  amount     integer not null,
  status     text not null default 'draft',
  created_at integer not null default (unixepoch())
);
create index billing__invoices_org on billing__invoices(org_id, created_at);
```

## Connection settings

- One writer connection + a small reader pool per tenant; `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout`, prepared statement cache, `foreign_keys=ON`.
- Connections are not shared across threads concurrently; the pool lives on the cell's worker thread.
- WAL checkpoints are scheduled so busy tenants' WAL files do not grow unbounded.
- Idle tenant connections are closed together with their isolate to keep file descriptor counts bounded.
- A per-tenant file size quota is enforced by `max_page_count`.

## The `db` API (tenant side)

The database is not a module a tenant installs; it comes with the cell. Every app has a `db` handle in `ctx` from the first line of code, with no connection string, credentials, or pool to manage. Locally it points at `./.renox/data/app.db`; in production it points at the tenant's file in its cell. The code is identical.

```ts
const rows  = await db.query<Product>("select * from shop__products where org_id = ? limit 50", [orgId]);
const one   = await db.queryOne("select * from shop__products where id = ?", [id]);
const info  = await db.execute("update shop__products set stock = stock - 1 where id = ?", [id]);
await db.transaction(async (tx) => { /* same API on tx */ });
const scoped = db.scoped({ user_id: user.id });   // ownership filter applied automatically (see 11-authorization.md)
```

Only parameterized statements. String interpolation into SQL is rejected by a lint in `renox check`.

### API layers

| Layer | Shape | Status |
| --- | --- | --- |
| Base | `db.query`, `db.queryOne`, `db.execute`, `db.transaction`, always with `?` parameters | Platform (`renox-data`), F1 |
| Safety | `db.scoped({ user_id })` adds ownership predicates for tables with declared ownership | Platform, F5 |
| Types | `renox dev` introspects the SQLite schema into `.renox/types/db.d.ts`; `db.query<Product>` gets table and column completion; a generated `Tables` type is available for builders | Platform, F2 |
| Query builder (optional) | Drivers for **Kysely** and **Drizzle**, both of which support SQLite and expose a custom-driver interface: `import { drizzle } from "renox/drizzle"`, `import { kysely } from "renox/kysely"`. The driver forwards compiled SQL + parameters to the `db` op, so authorizer and scoping still apply | SDK package, F4+ |
| Heavy ORMs (Prisma, TypeORM) | Not supported initially | Need a separate engine or Node internals; do not fit the isolate model |

Raw parameterized SQL is the primary path because it is the fastest and the easiest to audit. Builders are a thin layer on top, never a second execution path.

### External datasources (bring your own database)

Some tenants already run Postgres or must reach a legacy MySQL. For these there is an explicit connector, which is the only place a tenant ever "connects" to anything:

```toml
# renox.toml
[datasources.warehouse]
kind   = "postgres"            # postgres | mysql
secret = "WAREHOUSE_DSN"       # connection string stored as a secret, never in the file
pool   = { max = 5 }
```

```ts
const rows = await ctx.datasource("warehouse").query("select ... where id = $1", [id]);
```

- The connection pool lives in Rust inside the cell (`sqlx`), not in tenant code. The tenant receives only a handle with the same `query`/`queryOne`/`execute`/`transaction` API; placeholders and dialect are those of the target database.
- The target host must be in the tenant's network allowlist, and credentials come from secrets.
- Official modules write the SQLite dialect only (D18). A module that wants to run on an external Postgres must declare itself `postgres-ready` and is tested against both.
- Datasource queries are metered as `db_ms` like local queries, with a separate `datasource` label.

### Moving up a tier

| Tier | What happens | Who does it |
| --- | --- | --- |
| Free | One SQLite file, Litestream to S3 every few seconds | Automatic |
| Starter / Pro | Plus a synchronous replica on another node with automatic failover | Automatic |
| Large | `renox db migrate-to postgres`: the platform copies the tenant file into managed Postgres (schema translated by the migration tool), then `ctx.db` points there | One command, with a short read-only window |

Tenant code does not change when moving up unless it uses SQLite-only features; `renox check --target postgres` reports those.

### Local tooling

| Command | Purpose |
| --- | --- |
| `renox db shell` | Open the local SQLite file and run queries |
| `renox db seed` | Load sample data from `seeds/*.sql` or `seeds/*.ts` |
| `renox db export [--out file]` | Download a consistent snapshot of the production file to the laptop for debugging, through a signed URL, with its SHA-256 checked (`cli/README.md`, "`renox db`"; column masking is F7) |
| `renox db import <file> --app <staging-app>` | Push a file to a staging app; production apps and tables outside the naming rules are refused (`cli/README.md`, "`renox db`") |
| `renox db diff` | Compare the current schema with migrations and draft the next migration file (later phase) |
| `cp .renox/data/app.db test.db` | A database "branch" is a file copy: try a risky migration on the copy, discard on failure |

### Data-adjacent features that are deliberately separate

| Need | Solution | Shape |
| --- | --- | --- |
| Full-text search | SQLite FTS5 | `search` module |
| Vectors / AI | `sqlite-vec` | Platform extension enabled per tenant |
| Files and images | Object storage + metadata table | `storage` module |
| Ephemeral cache (KV) | `ctx.kv` in cell memory, not in the file | Platform |
| Job queue | `renox__outbox` | Platform; UI via the `jobs` module |

What will not exist: connection strings in tenant code, heavy ORMs, and `down` migrations.

## Durable events and realtime from data

- **Outbox**: events are written to `renox__outbox` in the same transaction as the data. The cell's outbox worker is woken by SQLite's `update_hook` (no polling across thousands of files) and delivers events with retries and a dead-letter table.
- **Change feed**: `update_hook` also reports table and rowid changes, which the realtime component maps to topics (filtered by policy). No logical replication needed.

## Replication and backup tiers

| Tier | Mechanism | RPO / RTO | Cost |
| --- | --- | --- | --- |
| Free / hobby | Litestream streaming WAL frames to S3 | Up to ~10 s of data loss; restore in seconds to minutes | Very low |
| Paid | libSQL / LiteFS synchronous replica on a second node | Near zero; automatic failover | 2x memory and disk |
| Large | Postgres | Standard Postgres HA | Per Postgres |

Failover: the control plane marks the node unhealthy, reassigns the tenant's cell to another node, which restores the file from the replica or from S3, then updates the route table. The rules, with the B18 target each serves, are FO1–FO6 in [`contracts/deploy-api.md`](contracts/deploy-api.md) section 16.

## What is lost compared with Postgres, and the replacement

| Lost | Replacement |
| --- | --- |
| Row-level security | Tenant isolation via file per tenant (stronger). In-app row ownership via `db.scoped()`, Cedar in guards and actions, mandatory authorization tests for official modules |
| `LISTEN/NOTIFY` | Not needed: all of a tenant's requests are on one node; in-process pub/sub |
| Logical replication for realtime | `update_hook` |
| Schemas | Table prefixes + authorizer |
| Rich `ALTER TABLE` | Expand/contract migrations; table rebuilds generated by the migration tool |
| Concurrent writers | One writer per tenant; tier limits; upgrade path |

## Upgrade path to Postgres

Tenants that exceed write or size limits are moved to Postgres. Because modules write the SQLite dialect only (D18), official modules are maintained with dual test suites, and third-party modules must mark themselves "Postgres-ready" to be installed on Postgres tenants. This restriction is decided up front.
