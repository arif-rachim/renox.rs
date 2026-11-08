-- Quotations: lines with VAT, the customer's approval link, and the log of
-- what was said to the customer. Quotations and their lines belong to one
-- branch (branch_id) and are fenced by db.scoped() (renox.toml [authz.ownership]).

-- Numbers Q-000001, Q-000002, ... are company-wide and never reused: a row
-- here is one issued number. It is not an owned table (every branch draws from it).
create table app__quote_numbers (
  n integer primary key autoincrement,
  quote_id text not null
);

create table app__quotes (
  id text primary key,
  branch_id text not null references app__branches (id),
  customer_id text not null references app__customers (id),
  site_id text not null references app__sites (id),
  number text not null unique,
  status text not null default 'draft' check (status in ('draft', 'sent', 'approved', 'rejected', 'expired')),
  valid_until integer not null,
  notes text not null default '',
  subtotal_fils integer not null default 0,
  vat_fils integer not null default 0,
  total_fils integer not null default 0,
  created_by text not null,
  created_at integer not null,
  approved_at integer,
  approved_ip text
);
create index app__quotes_branch on app__quotes (branch_id, created_at);
create index app__quotes_customer on app__quotes (customer_id);

-- line_total_fils is the net amount of the line (qty x unit price, VAT not
-- included); vat_rate is a percentage. branch_id repeats the quotation's so
-- the table carries its own ownership rule.
create table app__quote_lines (
  id integer primary key autoincrement,
  quote_id text not null references app__quotes (id),
  branch_id text not null references app__branches (id),
  service_id integer references app__services (id),
  description_en text not null,
  description_ar text not null,
  qty real not null check (qty > 0),
  unit_price_fils integer not null check (unit_price_fils >= 0),
  vat_rate integer not null default 5,
  line_total_fils integer not null
);
create index app__quote_lines_quote on app__quote_lines (quote_id);

-- A link to the customer: only the SHA-256 of the token is stored. kind says
-- what it opens ('approve'); ref_id is the row it names; expires_at is unix seconds.
create table app__links (
  token_hash text primary key,
  kind text not null,
  ref_id text not null,
  expires_at integer not null,
  used_at integer
);
create index app__links_ref on app__links (kind, ref_id);

-- What the app told a customer (the sending itself is a later step): one row
-- per message, with the kind ('quote_sent', 'quote_approved', ...) and its subject.
create table app__customer_messages (
  id integer primary key autoincrement,
  branch_id text not null references app__branches (id),
  customer_id text not null references app__customers (id),
  kind text not null,
  ref_id text not null,
  by_user_id text,
  created_at integer not null
);
create index app__customer_messages_customer on app__customer_messages (customer_id, created_at);
