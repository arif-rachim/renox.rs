-- The email module (#328).
create table email__messages (
  id          text    primary key,
  to_address  text    not null,
  subject     text    not null,
  text_body   text    not null default '',
  html_body   text    not null default '',
  status      text    not null check (status in ('queued', 'sent', 'failed', 'suppressed')),
  provider_id text,
  error       text,
  attempts    integer not null default 0,
  at          integer not null,
  updated_at  integer not null
) strict;
create index email__messages_at on email__messages (at);

create table email__suppressions (
  address    text    primary key,             -- lower case
  reason     text    not null check (reason in ('bounce', 'complaint', 'manual')),
  at         integer not null
) strict;
