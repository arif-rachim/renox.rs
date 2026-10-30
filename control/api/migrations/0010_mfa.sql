-- Second factors for control-plane accounts (#293; docs/24-threat-model.md
-- E, "Account takeover of a tenant developer"). The TOTP secret is sealed
-- with a key derived from the master key; recovery codes are stored as
-- SHA-256 only, like every other secret-bearing value of 0003.

create table account_mfa_totp (
  user_id       text primary key references users (id),
  secret_sealed text not null,
  confirmed_at  bigint,
  last_step     bigint,
  created_at    bigint not null
);

create table account_mfa_webauthn (
  id            text primary key,
  user_id       text not null references users (id),
  credential_id text not null unique,
  public_key    text not null,
  algorithm     integer not null,
  counter       bigint not null,
  name          text not null,
  created_at    bigint not null
);
create index account_mfa_webauthn_user on account_mfa_webauthn (user_id);

create table account_mfa_challenges (
  challenge  text primary key,
  user_id    text not null references users (id),
  purpose    text not null check (purpose in ('register', 'verify')),
  expires_at bigint not null,
  used_at    bigint
);

create table account_recovery_codes (
  user_id     text not null references users (id),
  code_sha256 text not null check (code_sha256 ~ '^[0-9a-f]{64}$'),
  used_at     bigint,
  created_at  bigint not null,
  primary key (user_id, code_sha256)
);

-- A session's second factor: `mfa_state` is 'verify' (signed in with the
-- password, the second factor not yet given) or 'enrol' (an owner or admin
-- past the grace period without one); null when the session is complete.
-- `mfa_at` is when the session last passed the second factor (step-up).
alter table sessions add column mfa_state text check (mfa_state in ('verify', 'enrol'));
alter table sessions add column mfa_at bigint;

-- A team may require a second factor of every member at once.
alter table tenants add column mfa_required boolean not null default false;
