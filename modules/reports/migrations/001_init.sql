-- The reports module (#333): money in and out as billing reports it (from
-- its events; one row per event, so a redelivery is not counted twice),
-- and the nightly snapshots of the day's totals.
create table reports__cash (
  id          text    primary key,           -- <kind>:<invoice id>:<amount>:<event time>
  kind        text    not null check (kind in ('received', 'refunded')),
  invoice_id  text    not null,
  amount      integer not null check (amount >= 0),   -- fils
  at          integer not null
) strict;
create index reports__cash_at on reports__cash (at);

create table reports__snapshots (
  day         text    primary key,           -- YYYY-MM-DD (UTC)
  totals      text    not null,              -- JSON: sales and cash totals
  sent_to     text,
  created_at  integer not null
) strict;
