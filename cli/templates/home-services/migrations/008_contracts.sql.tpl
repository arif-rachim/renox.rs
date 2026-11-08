-- Annual maintenance contracts (F7-126): a contract lists services at sites with
-- a visit frequency; the daily job jobs/amc-visits.ts creates the visits ahead
-- of time as jobs, jobs/amc-renewals.ts reminds the customer 30 days before the
-- end. Contracts, their items and their visit links belong to one branch and are
-- fenced by db.scoped() (renox.toml [authz.ownership]); each table repeats branch_id.

-- Numbers AMC-000001, AMC-000002, ... are company-wide and never reused, as the
-- job numbers are: not an owned table.
create table app__contract_numbers (
  n integer primary key autoincrement,
  contract_id text not null
);

-- Dates are local days, 'YYYY-MM-DD' (Asia/Dubai). price_fils is the yearly
-- price before VAT (the tax_gcc module adds the 5 %; vat_rate records the rate
-- the price was agreed with). 'upfront' is the only billing in v1: one tax
-- invoice at activation (invoice_id is its tax_gcc number). renewed_from is the
-- contract this one is the next year of. renewal_notified_on is the day the
-- customer was told the contract ends, so the reminder goes out once.
create table app__contracts (
  id text primary key,
  branch_id text not null references app__branches (id),
  customer_id text not null references app__customers (id),
  number text not null unique,
  status text not null default 'draft' check (status in ('draft', 'active', 'expired', 'cancelled')),
  starts_on text not null,
  ends_on text not null check (ends_on >= starts_on),
  price_fils integer not null check (price_fils >= 0),
  vat_rate integer not null default 5,
  billing text not null default 'upfront' check (billing in ('upfront')),
  notes text not null default '',
  invoice_id text,
  renewed_from text references app__contracts (id),
  renewal_notified_on text,
  created_by text not null,
  created_at integer not null,
  activated_at integer
);
create index app__contracts_branch on app__contracts (branch_id, status);
create index app__contracts_ends on app__contracts (status, ends_on);
-- A contract is renewed once (a cancelled renewal frees it).
create unique index app__contracts_renewed on app__contracts (renewed_from) where renewed_from is not null and status != 'cancelled';

-- One service at one site, visits_per_year times a year. next_visit_on is the
-- day the next visit falls due: the contract's start at first, then 365 /
-- visits_per_year days further after each visit the job creates.
create table app__contract_items (
  id integer primary key autoincrement,
  contract_id text not null references app__contracts (id),
  branch_id text not null references app__branches (id),
  site_id text not null references app__sites (id),
  service_id integer not null references app__services (id),
  visits_per_year integer not null check (visits_per_year between 1 and 52),
  next_visit_on text not null
);
create index app__contract_items_contract on app__contract_items (contract_id);
create index app__contract_items_due on app__contract_items (next_visit_on);

-- The visits generated for a contract: the job made for an item on a due day.
-- (item_id, due_on) is unique, so a repeated run cannot make a visit twice.
create table app__contract_jobs (
  contract_id text not null references app__contracts (id),
  branch_id text not null references app__branches (id),
  item_id integer not null references app__contract_items (id),
  job_id text not null primary key references app__jobs (id),
  due_on text not null,
  created_at integer not null,
  unique (item_id, due_on)
);
create index app__contract_jobs_contract on app__contract_jobs (contract_id, due_on);

-- The upfront invoice of a contract is a row of app__job_invoices with no job
-- (job_id is a text primary key without `not null`, which SQLite lets hold
-- NULL), so the list, the payments, the statement and the status view work for
-- it unchanged. contract_id names the contract; one invoice per contract.
alter table app__job_invoices add column contract_id text references app__contracts (id);
create unique index app__job_invoices_contract on app__job_invoices (contract_id) where contract_id is not null;
