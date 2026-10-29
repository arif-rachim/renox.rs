-- Platform tables of the durable event outbox (ADR D14; docs/contracts/ops.md
-- section 15.4). Written through the platform handle only: a module's
-- authorizer refuses every renox__* table.
--
-- One row per delivery. `op_events_emit` inserts the event with target ''
-- (not yet fanned out); the cell's delivery worker replaces it with one row
-- per module that has an `on` handler for it, each with its own attempts.
create table if not exists renox__outbox (
  id         text    not null,              -- the event id, a ULID
  target     text    not null default '',   -- handling module; '' = fan-out pending
  name       text    not null,              -- <module>.<event>
  payload    text    not null,              -- JSON
  module     text    not null,              -- the emitting module
  created_at integer not null,              -- Unix ms
  attempts   integer not null default 0,
  next_at    integer not null,              -- Unix ms; due when <= now
  last_error text,                          -- redacted, never the payload
  primary key (id, target)
) strict;
create index if not exists renox__outbox_next_at on renox__outbox (next_at);

create table if not exists renox__outbox_dead (
  id         text    not null,
  target     text    not null,
  name       text    not null,
  payload    text    not null,
  module     text    not null,
  created_at integer not null,
  attempts   integer not null,
  next_at    integer not null,
  last_error text,
  dead_at    integer not null,              -- Unix ms
  primary key (id, target)
) strict;
create index if not exists renox__outbox_dead_dead_at on renox__outbox_dead (dead_at);

-- Counters of the outbox (dead letters pruned by the cap).
create table if not exists renox__outbox_meta (
  key   text    primary key,
  value integer not null
) strict;
