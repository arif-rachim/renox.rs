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
