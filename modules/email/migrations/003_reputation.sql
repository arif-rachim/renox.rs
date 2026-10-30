-- The email module (#123): the tenant's sending reputation per day, and a
-- pause when complaints or bounces pass the thresholds.
create table email__reputation (
  day         text    primary key,           -- YYYY-MM-DD (UTC)
  sent        integer not null default 0,
  bounced     integer not null default 0,
  complained  integer not null default 0
) strict;

create table email__state (
  id         integer primary key check (id = 1),
  paused_at  integer,
  reason     text
) strict;
