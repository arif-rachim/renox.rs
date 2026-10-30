-- Break-glass impersonation (#310; deploy-api.md 0.4 section 17,
-- impersonateTenant and endImpersonation): one row per impersonation, with
-- the tenant token it issued (looked up by the middleware so every request
-- made with it is audited as the operator's).
create table impersonations (
  id          text   primary key,
  tenant_id   text   not null references tenants (id),
  operator    text   not null,              -- `operator` or the account's usr_ id (acct_ on the wire)
  reason      text   not null,
  scopes      jsonb  not null,
  token_id    text   not null unique,
  audit_id    text   not null,
  started_at  bigint not null,
  expires_at  bigint not null,
  ended_at    bigint,
  ended_by    text   check (ended_by in ('operator', 'timeout'))
);
create index impersonations_active on impersonations (tenant_id) where ended_at is null;
