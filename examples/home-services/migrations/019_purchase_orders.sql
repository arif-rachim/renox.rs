-- Purchase orders (#815, wave D, inventory): the office orders parts from a supplier with a numbered order, sends it
-- as a PDF, and books what arrives into the branch's stock at the price paid. A purchase order and its lines belong
-- to one branch (branch_id, repeated on each line) and are fenced by db.scoped() ([authz.ownership] in renox.toml).
-- Numbers PO-000001, PO-000002, ... are company-wide and never reused: a row of app__po_numbers is one issued
-- number, like app__quote_numbers (not owned: every branch draws from it). `status`: draft (lines change), sent (the
-- supplier has it), partly_received, received (every line in full, `closed_at` set) or cancelled (never after a
-- receipt). `received_qty` of a line only grows, by the receipts that went through lib/stock.ts. Money in fils.
create table app__po_numbers (
  n integer primary key autoincrement,
  po_id text not null
);

create table app__purchase_orders (
  id text primary key,
  branch_id text not null references app__branches (id),
  supplier_id text not null references app__suppliers (id),
  number text not null unique,
  status text not null default 'draft' check (status in ('draft','sent','partly_received','received','cancelled')),
  language text not null default 'en' check (language in ('en','ar')),
  expected_on text,
  notes text not null default '',
  created_by text not null,
  created_at integer not null,
  sent_at integer,
  closed_at integer
);
create index app__purchase_orders_branch on app__purchase_orders (branch_id, created_at);

create table app__purchase_order_lines (
  id integer primary key autoincrement,
  po_id text not null references app__purchase_orders (id),
  branch_id text not null,
  part_id text not null references app__parts (id),
  qty real not null check (qty > 0),
  unit_cost_fils integer not null check (unit_cost_fils >= 0),
  received_qty real not null default 0
);
create index app__purchase_order_lines_po on app__purchase_order_lines (po_id);
