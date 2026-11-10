-- Spreadsheet imports (F7-200): the owner brings customers, sites, services and
-- contracts in from Excel. A file is checked first (nothing is written but this
-- row), and a file with no errors can then be committed in one transaction.
-- Not owned by a branch: only the owner (settings.write) reaches it, and one
-- file may span branches.
--
-- file_key is the stored upload under app/imports/. report is JSON:
-- { "errors": [{ "row", "column", "code" }, ...at most 200], "insert", "update", "exists" };
-- rows is the number of data rows, ok the rows to write (insert + update), skipped
-- the rows already there ("exists"), errors the number of errors found (all of them,
-- not only the 200 kept).
create table app__imports (
  id text primary key,
  kind text not null check (kind in ('customers', 'sites', 'services', 'contracts')),
  file_key text not null,
  file_name text not null,
  status text not null check (status in ('checked', 'committed', 'discarded')),
  rows integer not null default 0,
  ok integer not null default 0,
  skipped integer not null default 0,
  errors integer not null default 0,
  report text not null,
  created_by text,
  created_at integer not null,
  committed_at integer
);
create index app__imports_created on app__imports (created_at desc);
