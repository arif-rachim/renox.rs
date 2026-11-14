-- Two more import kinds (#816, wave D, inventory): `parts` (the parts list) and `stock` (the opening balances).
-- SQLite cannot alter a CHECK, so the table is rebuilt the way SQLite documents it, as 012 did (create the new
-- table, copy, drop, rename, recreate the index). Nothing references app__imports.
create table app__imports_new (
  id text primary key,
  kind text not null check (kind in ('customers', 'sites', 'services', 'contracts', 'parts', 'stock')),
  file_key text not null,
  file_name text not null,
  status text not null check (status in ('checking', 'checked', 'committing', 'committed', 'discarded', 'failed')),
  rows integer not null default 0,
  ok integer not null default 0,
  skipped integer not null default 0,
  errors integer not null default 0,
  report text not null,
  created_by text,
  created_at integer not null,
  committed_at integer,
  error text,
  checked_at integer
);
insert into app__imports_new (id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at, committed_at, error, checked_at)
  select id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at, committed_at, error, checked_at from app__imports;
drop table app__imports;
alter table app__imports_new rename to app__imports;
create index app__imports_created on app__imports (created_at desc);
