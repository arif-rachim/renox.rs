-- The tax_gcc module (#331). Documents are immutable once issued; numbers
-- are sequential without gaps per prefix (FTA tax invoice rules).
create table tax_gcc__sequences (
  prefix text    primary key,
  next   integer not null
) strict;

create table tax_gcc__documents (
  number     text    primary key,           -- INV-000001, CN-000001
  kind       text    not null check (kind in ('invoice', 'credit_note')),
  against    text,                          -- a credit note's invoice
  body       text    not null,              -- JSON document
  standard   integer not null,              -- taxable at 5 %, fils (negative for a credit note)
  zero       integer not null,
  exempt     integer not null,
  vat        integer not null,
  issued_at  integer not null
) strict;
create index tax_gcc__documents_issued on tax_gcc__documents (issued_at);
