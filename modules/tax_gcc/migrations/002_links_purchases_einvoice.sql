-- The tax_gcc module (#331): the billing invoice a tax invoice was stamped
-- from (one each, so a redelivered event issues nothing twice), purchases
-- for the input side of the VAT return, and e-invoicing submissions.
create table tax_gcc__links (
  source     text    primary key,            -- billing:<invoice id>
  number     text    not null references tax_gcc__documents (number)
) strict;

create table tax_gcc__purchases (
  id          text    primary key,
  supplier    text    not null,
  supplier_trn text,
  net         integer not null check (net >= 0),   -- fils
  vat         integer not null check (vat >= 0),   -- fils, recoverable input VAT
  rate        text    not null check (rate in ('standard', 'zero', 'exempt')),
  booked_at   integer not null
) strict;
create index tax_gcc__purchases_booked on tax_gcc__purchases (booked_at);

create table tax_gcc__einvoice (
  number      text    primary key references tax_gcc__documents (number),
  provider    text    not null,
  provider_id text,
  status      text    not null check (status in ('submitted', 'accepted', 'rejected', 'cancelled')),
  updated_at  integer not null
) strict;
