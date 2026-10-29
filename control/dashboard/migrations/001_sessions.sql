-- Dashboard sign-ins: one row per platform session (`ctx.session.id`, the
-- signed `__Host-renox_sid` cookie) that holds a control-API token. The token
-- is stored only encrypted (AES-256-GCM, key derived from the DASHBOARD_KEY
-- secret, the session id as associated data); see lib/session.ts.
create table app__sessions (
  session_id text primary key,
  token_iv text not null,
  token_ct text not null,
  created_at integer not null,
  seen_at integer not null
) strict;
