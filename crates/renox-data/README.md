# renox-data

One SQLite file per tenant (ADR D5, `docs/06-data.md`). Leaf crate: it depends on no other `renox-*` crate and never links V8.

## API

```rust
use renox_data::{DbOptions, TenantDb, Value};

let db = TenantDb::open("/var/lib/renox/tenants/t_123.db", DbOptions::default())?;
db.execute("insert into app__products (id, name) values (?, ?)", &["p1".into(), "Dates".into()])?;
let rows = db.query("select id, name from app__products where id = ?", &["p1".into()])?;
let one = db.query_one("select count(*) as n from app__products", &[])?;
db.transaction(|tx| {
    tx.execute("update app__products set stock = stock - 1 where id = ?", &["p1".into()])?;
    Ok::<_, renox_data::DbError>(())
})?;
db.close()?;
```

| Item | Meaning |
| --- | --- |
| `TenantDb::open(path, DbOptions)` | Opens the writer and the reader pool, applies the pragmas, verifies `journal_mode` is `wal`, creates the platform tables |
| `query(sql, params) -> Vec<Row>` | All rows. Runs on a reader; a statement that writes (`insert ... returning`) runs on the writer |
| `query_one(sql, params) -> Option<Row>` | First row; the statement stops after it |
| `execute(sql, params) -> ExecResult { changes, last_insert_rowid }` | Runs on the writer |
| `transaction(\|tx\| ...)` | `begin immediate` on the writer; commit on `Ok`, rollback on `Err` or panic. `tx` has `query`, `query_one`, `execute`. While it is open, a nested `transaction` or a write through the `TenantDb` returns `TxState`; reads through the `TenantDb` run on a reader, outside the transaction |
| `read_pragma(name) -> Vec<Value>` | A pragma read from every connection, writer first (health checks, tests) |
| `close()` | Closes every connection; the cell calls it on idle eviction |

`Value` is `Null | Integer(i64) | Real(f64) | Text(String) | Blob(Vec<u8>)`. `Row` is an ordered list of `(column name, Value)`; `row.get("name")` looks a column up. Parameters are positional (`?` or `?NNN`); named parameters are refused.

Statements are prepared with `prepare_cached` (64 statements per connection). The handle is `Send` but not `Sync`: it lives on the cell's worker thread and no connection is used by two threads at once.

## Options

| Field | Default | Meaning |
| --- | --- | --- |
| `busy_timeout_ms` | 2000 | Wait for the write lock before `Busy` (`docs/contracts/ops.md` section 1, "Limits") |
| `max_page_count` | 25600 (100 MB free tier ÷ 4096) | File size quota in 4096-byte pages; `DbOptions::with_quota_bytes(PAID_QUOTA_BYTES)` gives the 10 GB paid quota |
| `readers` | 2 | Reader connections (at least 1) |
| `statement_timeout_ms` | 1000 | Per-statement time limit |
| `wal_checkpoint_pages` | 1000 | WAL size that makes `maybe_checkpoint` run a passive checkpoint |
| `module_prefix` | `None` | Module whose authorizer the handle gets on open; `None` is a platform handle |

## Pragmas applied on open

| Pragma / setting | Value | Connections |
| --- | --- | --- |
| `page_size` | 4096 (new files) | writer |
| `journal_mode` | `wal`, verified | writer (persistent in the file) |
| `synchronous` | `NORMAL` | writer |
| `foreign_keys` | `ON` | all |
| `busy_timeout` | `busy_timeout_ms` | all |
| `max_page_count` | `max_page_count` | all |
| `trusted_schema` | `OFF` | all |
| `SQLITE_DBCONFIG_DEFENSIVE` | on | all |

Readers are opened read-only. Open flags exclude URI file names.

## Errors

| `DbError` | Code (`docs/contracts/ops.md`) |
| --- | --- |
| `Busy` | `RENOX_DB_BUSY` |
| `Sqlite { code, message }` | `RENOX_DB_SQL` |
| `Auth { table, action }` | `RENOX_DB_AUTH` |
| `Timeout` | `RENOX_DB_TIMEOUT` |
| `QuotaExceeded` | `RENOX_DB_QUOTA` (reads continue) |
| `Constraint { kind, message }` | `RENOX_DB_CONSTRAINT` |
| `Param`, `ColumnName`, `MultiStatement`, `TxState` | `RENOX_DB_PARAM`, `RENOX_DB_COLUMN_NAME`, `RENOX_DB_MULTI_STATEMENT`, `RENOX_DB_TX_STATE` |
| `Open` | `RENOX_INTERNAL` |

`DbError::code()` returns the code. No message contains the file path; `TenantDb`'s `Debug` output leaves it out too.

Not here: the row and byte limits per call (`RENOX_DB_RESULT_LIMIT`) and the SQL text and parameter count limits belong to the `db` op (#28).

## Platform tables

Created on open if missing:

```sql
create table if not exists renox__migrations (
  module     text    not null,  -- module name, `app` for the app's own migrations
  name       text    not null,  -- file name, NNN_name.sql
  checksum   text    not null,  -- lower-case sha256 hex of the file bytes
  applied_at integer not null,  -- unix seconds
  primary key (module, name)
) strict;
```

## Authorizer

ADR D13 and `docs/06-data.md`: every statement from a module passes through a SQLite authorizer limited to that module's prefix. SQLite calls it while compiling a statement, so a refused statement never runs; no SQL is parsed in Rust.

```rust
use renox_data::AuthorizerPolicy;

let db = TenantDb::open(path, DbOptions::default())?
    .with_authorizer(AuthorizerPolicy::module("billing").with_read_deps(["auth"]))?;
```

`with_authorizer` installs the policy on every connection of the handle (writer and readers). `DbOptions { module_prefix: Some("billing".into()), .. }` does the same on open.

| Action | Allowed for module `m` |
| --- | --- |
| `READ`, `INSERT`, `UPDATE`, `DELETE` | Tables and views named `m__*` in the main database |
| `READ` | Views `d__public_*` for each `d` in `read_deps`, and the columns those views read (SQLite reports them with the view as accessor) |
| `SELECT`, `RECURSIVE` (CTEs), built-in functions | Always, except `load_extension` and `fts3_tokenizer` |
| `TRANSACTION`, `SAVEPOINT` | When `allow_ddl` is false (the migration runner owns the transaction when it is true) |
| `CREATE TABLE/INDEX/VIEW`, `ALTER TABLE`, `DROP TABLE/INDEX/VIEW/TRIGGER`, `REINDEX` | Only with `allow_ddl` (migrations), only for `m__*` names; DDL also needs the schema-table writes SQLite reports for it |
| Everything else | Refused: `PRAGMA` (reads and writes), `ATTACH`, `DETACH`, `CREATE TRIGGER`, temp objects, virtual tables, `ANALYZE`, reads of `sqlite_master` |

A refused statement fails with `DbError::Auth { table, action }` (`RENOX_DB_AUTH`): `table` names the object of the first refused action, `action` the SQLite action (`READ`, `INSERT`, `CREATE_TABLE`, `PRAGMA`, `ATTACH`, ...).

Rules that follow from SQLite's behaviour:

- A view with the module's own prefix that reads another module's table does not grant access: only `<dep>__public_*` views pass reads through.
- Trigger bodies are checked against the policy of the statement that fires them, so a platform trigger on a module table does not give the module access to the trigger's targets.
- A foreign key from `m__*` to another module's table makes SQLite report a `READ` of the parent table, which is refused. Cross-module references are an F4 question (module broker); in F1 only the `app` module runs.
- `ALTER TABLE ... RENAME TO` reports only the old name. The migration runner therefore also checks the schema after each file (see "Migrations").

### Reserved module names

| Name | Meaning |
| --- | --- |
| `app` | The tenant application's own code and migrations; tables `app__*` (`docs/07-app-model.md`) |
| `renox` | The platform (`renox__*` tables). A `renox` policy installs no restrictions; the cell uses it for platform tables |

Module names match `^[a-z][a-z0-9_]{0,31}$` (artifact contract), may not contain `__` and may not end with `_`, so one module's prefix is never a prefix of another's. `renox` cannot be a dependency.

### Performance

The authorizer runs at prepare time only. With the statement cache, it runs once per distinct SQL text per connection; executing a cached statement does not call it. Changing a handle's policy flushes the statement cache, so a statement prepared under one policy is never reused under another.

## Limits, deadline, checkpoints, stats

`docs/04-isolation-security.md` (per-tenant database limits), `docs/contracts/ops.md` section 1 ("Limits").

| Limit | How | Error |
| --- | --- | --- |
| Statement time | A `progress_handler` on every connection checks the clock every 1,000 VM instructions and interrupts at `min(statement_timeout_ms, request deadline)`. The statement limit counts from the first VM instructions, so the wait for the write lock (which SQLite takes first) is not part of it | `Timeout` |
| Request deadline | `QueryCtx { deadline }` passed to `query_with`, `query_one_with`, `execute_with` (and the same on `Tx`). The methods without `_with` use no deadline. A call whose deadline has passed fails before it runs | `Timeout` |
| Busy wait | `busy_timeout_ms`, lowered for one call to the time left before the request deadline | `Busy` |
| File size | `max_page_count` | `QuotaExceeded` |

A timeout inside `transaction` rolls the whole transaction back. Later statements on that `Tx` fail with `TxState`, and `transaction` returns `Timeout` even if the closure caught the error, so nothing is committed.

### WAL checkpoints

The writer replaces SQLite's automatic checkpoint-on-commit with a WAL hook that records the WAL size (`wal_pages()`). The cell schedules checkpoints:

| Call | Effect |
| --- | --- |
| `maybe_checkpoint()` | `PASSIVE` checkpoint when the WAL holds `wal_checkpoint_pages` (default 1,000) or more; the cell calls it on a schedule and when the tenant is idle |
| `checkpoint(CheckpointMode::Passive \| Truncate)` | Explicit checkpoint; `Truncate` waits for readers and truncates the WAL file to zero bytes |
| `close()` | `TRUNCATE` checkpoint, then closes every connection |
| Safety net | At 4 × `wal_checkpoint_pages` the writer runs a `PASSIVE` checkpoint on commit by itself, so the WAL stays bounded if the scheduler stalls |

### Stats for the meter

`stats()` returns `DbStats { statements, rows_read, rows_written, busy_waits, timeouts, total_ms }`, counted since the handle was opened. The cell takes a snapshot before and after a request and records `after.since(&before)`: `db_ms()` is `total_ms` (wall time in statements, including waits for the write lock), and `db_rows()` is rows returned plus rows changed (`docs/contracts/meter.md`). `busy_waits` counts statements that gave up with `Busy`.
