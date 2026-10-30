-- deploy-api.md 0.4 section 18, "User token rule" (#307): the MFA endpoints
-- accept a user's own token; a verification made with a token counts for
-- that token only, so its step-up window is kept per token here (a session
-- keeps its own in sessions.mfa_at).
create table token_mfa (
  token_id text   primary key references tokens (id) on delete cascade,
  mfa_at   bigint not null
);
