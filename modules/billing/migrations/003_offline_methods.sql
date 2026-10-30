-- The billing module (#330): checkouts paid without a card PSP. Cash on
-- delivery follows the order through delivery; a bank transfer carries a
-- reference the customer quotes, matched against the bank statement.
alter table billing__checkouts add column method text not null default 'card';
alter table billing__checkouts add column reference text;
create unique index billing__checkouts_reference on billing__checkouts (reference) where reference is not null;

create table billing__cod_orders (
  order_id   text    primary key references billing__checkouts (order_id),
  state      text    not null check (state in ('placed', 'out_for_delivery', 'delivered', 'refused')),
  updated_at integer not null
) strict;

create table billing__transfers (
  id          text    primary key,
  booked_on   text    not null,
  amount      integer not null,
  description text    not null,
  order_id    text,
  imported_at integer not null
) strict;
