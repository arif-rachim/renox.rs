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
| `TenantDb::open(path, DbOptions)` | Opens the writer (readers are opened by the first read that needs them, with the same pragmas and policy, #145), applies the pragmas, verifies `journal_mode` is `wal`, creates the platform tables |
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
| `Scope { table, module, reason }` | `RENOX_DB_SCOPE` (`reason`: `unscoped`, `scope_missing`, `owner_mismatch`, `unprovable`; see "`db.scoped()`") |
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

Platform migrations under `migrations/` run on open after it, each idempotent:

| File | Tables |
| --- | --- |
| `0001_outbox.sql` | `renox__outbox` (one row per delivery: `id`, `target` = handling module or `''` while the fan-out is pending, `name`, `payload`, `module` = emitter, `created_at`, `attempts`, `next_at`, `last_error`; index on `next_at`), `renox__outbox_dead` (the same plus `dead_at`), `renox__outbox_meta` (counters) |
| `0002_authz.sql` | `renox__role_assignments` (`user_id`, `role`, `scope_type`, `scope_id` (`''` for a `global` assignment), `granted_by`, `at`; unique on the first four), `renox__authz_audit` (`id`, `principal`, `action`, `resource_type`, `resource_id`, `result` `allow`/`deny`, `policy`, `at`) and its view `renox__authz_audit_v1` |

A new file's WAL is checkpointed once after these run, so the tenant's own WAL accounting starts from an empty log.

### Authorization tables (`renox_data::roles`)

`ops.md` 1.5.0 section 17 (#277). Called by the ops (#279) on the platform connection, through a `TenantDb` (autocommit) or a `Tx` (the request's transaction):

| Function | What it does |
| --- | --- |
| `assign(db, &RoleAssignment, allowed)` | Inserts the assignment once (a second identical one is a no-op, `false`); `allowed` is the set a module may assign (`None` for the app); another role is refused before anything is written (`Param("role:<name>")`, which the op maps to `RENOX_MODULE_UNDECLARED`) |
| `revoke(db, user, role, scope_type, scope_id, allowed)` | `true` when a row was removed |
| `list(db, user)` | The user's assignments, by role, scope type, scope id |
| `record(db, &AuditRow)` | Appends one decision to `renox__authz_audit` |

`renox__authz_audit` is append-only for every connection, the platform's included: the authorizer refuses `UPDATE`, `DELETE`, `DROP`, `ALTER` (and dropping its view or a trigger on it). Modules never write it (it is a `renox__*` table); `SELECT` through `renox__authz_audit_v1` is allowed to the `audit` module and to modules that list `audit` among their read dependencies.

### `db.scoped()` (`renox_data::scoped`)

`docs/11-authorization.md`, "the RLS replacement" (D16), and `ops.md` 1.5.0 section 17 (#277). `Ownership` holds the owned tables (`[authz.ownership]`: owner column, optional org column); `Scope { user_id, org_id, session_id }` is the handle's scope. `rewrite(sql, params, &scope, &ownership)` parses the statement (`sqlparser`, SQLite dialect) and returns it with the owner predicates added, or refuses it:

| Shape | Result |
| --- | --- |
| `SELECT` with owned tables in its top-level `FROM` / `JOIN` (aliases included; `INNER`, `LEFT`, `CROSS`) | `"<alias>"."<owner>" = '<value>'` (and the org column when the table and the scope have one) in `WHERE`, or in the join's `ON` |
| `UPDATE` / `DELETE` of an owned table | the predicate ANDed to the parenthesised `WHERE` |
| `INSERT … VALUES (…)` with a column list | a missing owner (org) column is added with the scope's value; an explicit equal value (literal or `?`/`?NNN` parameter) passes; another value is `owner_mismatch` |
| an owned table in a subquery, a CTE, a set operation, a `RIGHT`/`FULL` join, `UPDATE … FROM`, `INSERT … SELECT`, `INSERT` without a column list, `INSERT OR REPLACE` / `REPLACE`, an upsert `DO UPDATE` | `unprovable`, refused whole |
| a table whose owner column is `session_id` without `scope.session_id`, or a user column without `scope.user_id` | `scope_missing` |

Scope values are SQL string literals with quotes doubled, never parameters, so the caller's `?` numbering stays valid. A statement without an owned table comes back unchanged. `tests/scoped.rs` lists the shapes it proves and refuses.

The rewritten statement runs under the module's policy with `AuthorizerPolicy::with_scoped(true)`. A module policy carries its owned tables (`with_owned`); a statement of module code that reaches one without `with_scoped` is refused at prepare time with `Scope { reason: unscoped }`. The app's policy (`app`) never refuses: `renox check` warns instead (#283, D16). Triggers cannot reach an owned table: no module may create one.

### The outbox (`renox_data::outbox`)

The durable events of `docs/contracts/ops.md` section 15.4 (ADR D14). Every function runs as the platform, also on a handle with a module authorizer; module SQL can never name a `renox__*` table.

| Function | Who calls it | What it does |
| --- | --- | --- |
| `emit(db, tx, ev)`, `emit_autocommit(db, ev)` | `op_events_emit` (#231) | Insert the event (target `''`) in the emitter's transaction, so a rollback never delivers; payload over 64 KiB is `Param` |
| `due(db, now, limit)`, `next_due_at(db)` | the delivery worker (#229) | Rows with `next_at <= now`, by `next_at`; the earliest `next_at` for the worker's timer |
| `fan_out(db, id, targets, now)` | the worker | Replace the pending row with one delivery per handler module (none: the event is dropped) |
| `delivered(db, tx, id, target)` | the worker, in the handler's transaction | Delete the delivery, so the handler's writes and the acknowledgement commit together |
| `failed(...)`, `dead_letter(..., cap)` | the worker | Next attempt time and redacted error; move to `renox__outbox_dead` after the last attempt and prune the oldest dead letters past `DeadLetterCap` (10,000 rows or 8 MiB by default) |
| `stats(db)` → `OutboxStats` | the worker's gauges | `pending`, `dead`, `dead_bytes`, `dead_pruned` |

### Savepoints

`Tx::savepoint_begin`, `savepoint_release`, `savepoint_rollback` (and `Tx::savepoint(f)`) implement nested `db.transaction` (`ops.md` section 1, "Savepoints"): names are the platform's `renox_sp_<n>`, last-in first-out, at most `MAX_SAVEPOINTS` (32) open; any other order is `TxState`. Rolling back a savepoint undoes only its statements. Tenant SQL naming a savepoint `renox_*` is refused by the authorizer.

### Per-statement policy

`TenantDb::with_policy(policy, f)` runs `f` with another authorizer policy on every connection (`None` = the platform) and restores the handle's own afterwards. The runtime uses it per statement with the calling module's policy (`ops.md` section 1, "Module argument"), so one transaction can hold statements of several modules, each under its own authorizer. Switching to an equal policy keeps the prepared-statement cache.

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
| `READ` | Views `d__public_<name>_v<n>` (exactly `^d__public_[a-z0-9_]+_v[0-9]+$`, `manifest.md` MF6) for each `d` in `read_deps`, and the columns those views read (SQLite reports them with the view as accessor) |
| `SELECT`, `RECURSIVE` (CTEs), built-in functions | Always, except `load_extension` and `fts3_tokenizer` |
| `TRANSACTION`, `SAVEPOINT` | When `allow_ddl` is false (the migration runner owns the transaction when it is true); never a savepoint named `renox_*`, which belongs to the platform |
| `CREATE TABLE/INDEX/VIEW`, `ALTER TABLE`, `DROP TABLE/INDEX/VIEW/TRIGGER`, `REINDEX` | Only with `allow_ddl` (migrations), only for `m__*` names. With `allow_ddl` the schema-table reads and writes SQLite reports for DDL are allowed too (`sqlite_master`, and `sqlite_sequence`, which SQLite creates for `autoincrement`) |
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
| `checkpoint(CheckpointMode::Passive \| Truncate)` | Explicit checkpoint; `Truncate` waits for readers and truncates the WAL file to zero bytes. Runs with the platform policy, also on a module handle (#147) |
| `close()` | `TRUNCATE` checkpoint, then closes every connection |
| Safety net | At 4 × `wal_checkpoint_pages` the writer runs a `PASSIVE` checkpoint on commit by itself, so the WAL stays bounded if the scheduler stalls |

### Stats for the meter

`stats()` returns `DbStats { statements, rows_read, rows_written, busy_waits, timeouts, total_ms }`, counted since the handle was opened. The cell takes a snapshot before and after a request and records `after.since(&before)`: `db_ms()` is `total_ms` (wall time in statements, including waits for the write lock), and `db_rows()` is rows returned plus rows changed (`docs/contracts/meter.md`). `busy_waits` counts statements that gave up with `Busy`.

## Migrations

ADR D17 (forward-only, checksums), `docs/06-data.md`, `docs/contracts/artifact.md` section 4. `migrate` runs one module's files; `migrate_all` runs an artifact's plan of several modules (below).

```rust
use renox_data::{migrate_with_checksums, MigrationFile};

let files = vec![MigrationFile { name: "001_init.sql".into(), sql: std::fs::read_to_string(p)? }];
// `checksums` is the `files` map of the artifact's migrations/checksums.json.
let report = migrate_with_checksums(&db, "app", &files, &checksums)?;
// report.applied: files run now; report.skipped: files applied before.
```

| Rule | Behaviour |
| --- | --- |
| Names | `^\d{3,}_[a-z0-9_]+\.sql$`, sorted by name; gaps allowed, duplicates refused (`InvalidName`, `DuplicateName`) |
| Checksum | Lower-case SHA-256 hex of the file bytes (`checksum()`). With `migrate_with_checksums`, every file must match its `<module>/<name>` entry of `checksums.json` before anything runs |
| Applied file changed | `ChecksumMismatch { name }`; nothing runs |
| One transaction per file | The file runs on the writer one statement at a time (one 30 s limit for the file), then `(module, name, checksum, applied_at)` is inserted into `renox__migrations`, then commit. A failing statement rolls the file back (`Failed { module, name, statement, source }`, the statement clipped to 200 characters); files before it stay applied |
| Authorizer | The file runs under `AuthorizerPolicy { module, allow_ddl: true }`: it can create, alter, and drop only `<module>__*` objects, cannot read or write other modules' tables or `renox__*`, and cannot run `PRAGMA`, `ATTACH`, `BEGIN`, or `COMMIT` |
| Schema check | `alter table ... rename to` reports only the old name to the authorizer, so after each file the runner compares `sqlite_master` with its state before the file: a new or renamed object outside the prefix fails the file (`OutsidePrefix`) and rolls it back |
| Time | Each file has 30 s (`MIGRATION_FILE_TIMEOUT`) |

Bookkeeping runs on the writer as the platform, so `migrate` works on a module handle too; the handle's own policy is back afterwards.

Known limit: `sqlite_sequence` (autoincrement counters) is shared by every module in the file, and SQLite writes it on rename and drop. A migration can therefore change another module's autoincrement counter (still open: SQLite's authorizer does not tell `sqlite_sequence` rows apart by table).

### Several modules: `migrate_all`

```rust
use renox_data::{migrate_all, ModuleMigrations};

// In the artifact's `modules` order (every module after its dependencies), the app last.
let plan = vec![
    ModuleMigrations { module: "auth".into(), dependencies: vec![], files: auth_files },
    ModuleMigrations { module: "org".into(), dependencies: vec!["auth".into()], files: org_files },
    ModuleMigrations { module: "app".into(), dependencies: vec!["auth".into(), "org".into()], files: app_files },
];
let report = migrate_all(&db, &plan, Some(&checksums))?; // report.modules: (module, MigrationReport) in order
```

- The plan order is checked first: a module listed twice, or before one of its dependencies, fails before anything runs.
- Each module's files run under `module(m).with_read_deps(deps).with_ddl(true)`: DDL and writes only on `<m>__*`, reads of the dependencies' `<dep>__public_*_v<n>` views (a module may build its own views on them). A statement on another module's table fails the file naming the module, the file, and the statement (`docs/24-threat-model.md`, "Module migration touching another module's tables").
- The first failure stops the plan: `PlanError { module, error, done }`, where `done` lists the modules applied before it (forward-only, they stay).

### No `down` migrations

There are none, by design (ADR D17, `docs/06-data.md`: "What will not exist: ... `down` migrations"). A rollback deploys an older artifact against the newer schema, so schema changes follow expand/contract: add a column or table in one release, stop using the old one in the next, remove it later. A `down` file would be code that runs only in an emergency and is never tested. Fixing a mistake means writing a new forward migration, and the checksums keep applied files from being edited in place.
