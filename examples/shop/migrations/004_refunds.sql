-- Refunds (#292): one per refunded order, by whom and when. The refund
-- itself is the sensitive action `invoice.refund` (renox.toml [authz]);
-- the platform writes its audit row in the same transaction.
create table app__refunds (
  id          integer primary key,
  order_id    integer not null unique references app__orders (id),
  amount_fils integer not null,
  refunded_by text    not null,
  created_at  integer not null
) strict;
