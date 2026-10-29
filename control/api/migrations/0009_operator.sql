-- Operator actions (docs/contracts/deploy-api.md 0.3 section 17, #259).

-- An account flagged `operator` may create `renox_op_` tokens with
-- `ops:write`. Set by hand (psql) for the platform's own staff; no endpoint
-- sets it.
alter table users add column operator boolean not null default false;

-- `renox_op_` tokens of operator accounts. The value is never stored: only
-- its SHA-256. The bootstrap operator token stays in the API's environment.
create table operator_tokens (
  id           text primary key,
  user_id      text not null references users (id),
  name         text not null,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  scopes       jsonb not null,
  created_at   bigint not null,
  expires_at   bigint not null,
  last_used_at bigint,
  revoked_at   bigint
);
create index operator_tokens_user on operator_tokens (user_id);

-- A tenant being moved to a microVM: its requests answer 503
-- RENOX_TENANT_MOVING at the node, and the API refuses another tier
-- change, move, export or import. `microvm_at`: the hook moved it.
alter table tenants add column moving_since bigint;
alter table tenants add column microvm_at bigint;
