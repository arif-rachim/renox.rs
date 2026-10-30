-- deploy-api.md 0.5 section 22 (#123): abuse tickets and their takedowns.
-- The reporter's address is kept only to answer them, and goes with the
-- ticket after 90 days.
create table abuse_tickets (
  id             text   primary key,
  hostname       text   not null,
  tenant_id      text,
  category       text   not null,
  description    text   not null,
  reporter_email text,
  state          text   not null,
  safe_browsing  text   not null default 'unknown',
  reported_at    bigint not null,
  updated_at     bigint not null,
  reason         text
);
create index abuse_tickets_state on abuse_tickets (state, reported_at);
