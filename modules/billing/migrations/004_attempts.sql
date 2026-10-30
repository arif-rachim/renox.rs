-- The billing module (#123): payment-attempt buckets per client IP and per
-- customer (card testing), and declines per customer (a blocklist after
-- repeated declines).
create table billing__attempts (
  bucket       text    primary key,          -- ip:<address> | customer:<id> | declines:<id>
  window_start integer not null,
  count        integer not null
) strict;
