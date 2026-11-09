-- Customers (companies or households), their sites, and the service
-- catalogue. Customers and sites belong to one branch (branch_id, app__branches.id)
-- and are fenced by db.scoped() (renox.toml [authz.ownership]).
create table app__customers (
  id text primary key,
  branch_id text not null references app__branches (id),
  kind text not null check (kind in ('company', 'household')),
  name text not null,
  trn text,
  phone text not null,
  email text,
  language text not null default 'en' check (language in ('en', 'ar')),
  created_at integer not null
);
create index app__customers_branch on app__customers (branch_id, name);
create index app__customers_phone on app__customers (branch_id, phone);

-- A place where work is done. branch_id repeats the customer's branch so the
-- table can carry its own ownership rule (a view cannot: V26 wants a table).
create table app__sites (
  id text primary key,
  customer_id text not null references app__customers (id),
  branch_id text not null references app__branches (id),
  label text not null,
  emirate text not null,
  area text not null,
  address text not null,
  makani text,
  lat real,
  lng real,
  access_notes text not null default ''
);
create index app__sites_customer on app__sites (customer_id);

-- The priced catalogue. branch_id null: offered by every branch.
create table app__services (
  id integer primary key autoincrement,
  branch_id text references app__branches (id),
  code text not null unique,
  name_en text not null,
  name_ar text not null,
  unit text not null check (unit in ('visit', 'hour', 'unit')),
  price_fils integer not null check (price_fils >= 0),
  vat_rate integer not null default 5,
  active integer not null default 1 check (active in (0, 1))
);
