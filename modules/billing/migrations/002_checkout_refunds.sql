-- The billing module (#329): one checkout per order (idempotent, the
-- duplicate session case), refunds against a paid invoice, the PSP events
-- applied (their type and result, never the payload), and the public view
-- other modules read a user's plan through.
create table billing__checkouts (
  order_id    text    primary key,
  customer_id text    not null,
  mode        text    not null check (mode in ('payment', 'subscription')),
  plan_id     text,
  amount      integer not null check (amount >= 0),
  currency    text    not null,
  session_id  text    not null,
  url         text    not null,
  status      text    not null check (status in ('open', 'completed', 'expired')),
  created_at  integer not null,
  updated_at  integer not null
) strict;
create index billing__checkouts_session on billing__checkouts (session_id);

alter table billing__invoices add column payment_intent text;
alter table billing__invoices add column refunded integer not null default 0;

create table billing__refunds (
  id          text    primary key,
  invoice_id  text    not null references billing__invoices (id),
  amount      integer not null check (amount > 0),
  psp_refund  text,
  at          integer not null
) strict;

create table billing__webhook_events (
  event_id    text    primary key,
  type        text    not null,
  result      text    not null,
  at          integer not null
) strict;

create view billing__public_user_plans_v1 as
  select customer_id as user_id, plan_id, status, current_period_end from billing__subscriptions;
