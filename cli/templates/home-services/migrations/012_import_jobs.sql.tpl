-- The import is checked and committed by background jobs (#733): a file is
-- read by `jobs/import-check.ts` and `jobs/import-commit.ts`, not in the
-- owner's request (a request has 50 ms of CPU on the free tier, a job attempt
-- the same until the platform gives jobs a budget of their own).
--
-- Three more statuses: `checking` (the row is made, the job has not finished),
-- `committing` (the owner asked for the import, the job has not finished) and
-- `failed` (the job could not do it: `error` is the i18n key of the reason,
-- `import.err.<code>`). `checked_at` is when the check finished. While
-- `checking`, `report` is the empty report.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt the way SQLite
-- documents (create the new table, copy, drop, rename, recreate the index).
-- Nothing references app__imports.
create table app__imports_new (
  id text primary key,
  kind text not null check (kind in ('customers', 'sites', 'services', 'contracts')),
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
  select id, kind, file_key, file_name, status, rows, ok, skipped, errors, report, created_by, created_at, committed_at, null, case when status in ('checked', 'committed') then created_at else null end from app__imports;
drop table app__imports;
alter table app__imports_new rename to app__imports;
create index app__imports_created on app__imports (created_at desc);
