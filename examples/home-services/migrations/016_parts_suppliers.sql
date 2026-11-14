-- Parts and suppliers (#812, wave D, inventory): the company's list of the parts it stocks and the suppliers it
-- buys from, kept from /admin/parts and /admin/suppliers. Both are company-wide, like app__services: no
-- branch_id, so neither is an owned table (stock per branch comes with the next issue). A part is never
-- deleted: `active = 0` keeps its history and takes it off the lists a visit or a purchase order picks from.
-- `sku` is stored upper-case (lib/parts.ts normalises it). Money is in fils; `min_stock` has at most three
-- decimals (a metre, a litre). `trn` is the supplier's tax registration number, normalised by the gcc module.
create table app__parts (
  id text primary key,
  sku text not null unique check (sku = upper(sku) and length(sku) between 1 and 32),
  name_en text not null,
  name_ar text not null,
  unit text not null check (unit in ('piece','metre','litre','kg','box')),
  cost_fils integer not null default 0 check (cost_fils >= 0),
  sell_fils integer not null default 0 check (sell_fils >= 0),
  vat_rate integer not null default 5 check (vat_rate in (0,5)),
  min_stock real not null default 0 check (min_stock >= 0),
  active integer not null default 1 check (active in (0,1)),
  created_at integer not null
);

create table app__suppliers (
  id text primary key,
  name text not null,
  trn text,
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  notes text not null default '',
  active integer not null default 1,
  created_at integer not null
);
