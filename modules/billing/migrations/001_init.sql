-- The billing module (#329): an app's own customers' plans, subscriptions,
-- invoices and usage. Amounts are integers in minor units (fils for AED).
create table billing__plans (
  id         text    primary key,
  name       text    not null,
  amount     integer not null check (amount >= 0),
  currency   text    not null,
  interval   text    not null check (interval in ('month', 'year')),
  created_at integer not null
) strict;

create table billing__subscriptions (
  customer_id        text    primary key,
  plan_id            text    not null references billing__plans (id),
  status             text    not null check (status in ('pending', 'active', 'past_due', 'cancelled')),
  stripe_customer    text,
  stripe_subscription text,
  current_period_end integer,
  updated_at         integer not null
) strict;

create table billing__invoices (
  id          text    primary key,           -- the PSP's invoice id
  customer_id text    not null,
  amount      integer not null,
  currency    text    not null,
  status      text    not null check (status in ('open', 'paid', 'void')),
  paid_at     integer,
  created_at  integer not null
) strict;
create index billing__invoices_customer on billing__invoices (customer_id, created_at);

create table billing__usage (
  id          text    primary key,
  customer_id text    not null,
  metric      text    not null,
  quantity    integer not null check (quantity >= 0),
  at          integer not null
) strict;
create index billing__usage_customer on billing__usage (customer_id, metric, at);
