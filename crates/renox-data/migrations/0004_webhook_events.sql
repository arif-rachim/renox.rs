-- Platform table of verified inbound webhook events (docs/contracts/ops.md
-- 1.7.0 section 22; #322). Written through the platform handle only, in the
-- request's transaction when one is open. A second delivery of the same
-- (provider, event_id) is a duplicate: the handler does not run again.
create table if not exists renox__webhook_events (
  provider    text    not null,
  event_id    text    not null,
  received_at integer not null,              -- Unix ms
  primary key (provider, event_id)
) strict;
create index if not exists renox__webhook_events_received on renox__webhook_events (received_at);
