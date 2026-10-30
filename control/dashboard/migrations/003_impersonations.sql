-- Break-glass sign-ins (#310; deploy-api.md 0.4 section 17): a dashboard
-- session signed in with an impersonation token. Every page shows a banner
-- while the row exists; it ends with the time box (expires_at), the
-- operator's end, or the sign-out. The token itself is in app__sessions,
-- encrypted like any other.
create table app__impersonations (
  session_id text primary key,
  impersonation_id text not null,
  tenant_id text not null,
  expires_at integer not null
) strict;
