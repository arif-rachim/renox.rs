-- The audit trail (#288; docs/11-authorization.md "Cross-module context and
-- audit"). Append-only: the triggers refuse every UPDATE, and every DELETE
-- of a row younger than 30 days (the retention floor; `prune` removes rows
-- past `retain_days`). They hold for every connection: module code, app
-- code, and a tool opening the file.
create table audit__events (
  id            text    primary key,
  at            integer not null,                 -- Unix ms, like renox__authz_audit
  actor_kind    text    not null check (actor_kind in ('user', 'agent', 'system')),
  actor_id      text    not null,
  client        text,                             -- the agent's client name (actor_kind = 'agent')
  action        text    not null,
  resource_type text,
  resource_id   text,
  result        text    not null check (result in ('ok', 'denied', 'failed')),
  details       text    not null default '{}',    -- JSON, secret-looking keys redacted
  request_id    text,
  source        text    not null default 'record' -- 'record', or the event name a listener recorded
) strict;
create index audit__events_at on audit__events (at);
create index audit__events_actor on audit__events (actor_id, at);

create trigger audit__events_no_update before update on audit__events
begin
  select raise(abort, 'audit__events is append-only');
end;

create trigger audit__events_no_delete before delete on audit__events
  when old.at >= (cast(strftime('%s', 'now') as integer) - 30 * 86400) * 1000
begin
  select raise(abort, 'audit__events is append-only');
end;
