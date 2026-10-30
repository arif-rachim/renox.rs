-- auth phase 2 (#291): phone-first sign-in, passkeys, UAE PASS. Expand only.
alter table auth__users add column phone text;               -- E.164, once verified
alter table auth__users add column phone_verified_at integer;
alter table auth__users add column uaepass_uuid text;
alter table auth__users add column verified_identity integer not null default 0;  -- UAE PASS SOP3
create unique index auth__users_phone on auth__users (phone) where phone is not null;
create unique index auth__users_uaepass on auth__users (uaepass_uuid) where uaepass_uuid is not null;

-- One-time codes for phone sign-in and phone verification: argon2id of the
-- code, 5 minutes, 5 attempts, single use.
create table auth__phone_codes (
  phone      text    not null,
  purpose    text    not null check (purpose in ('login', 'verify')),
  user_id    text    not null references auth__users (id),
  code_hash  text    not null,
  expires_at integer not null,
  attempts   integer not null default 0,
  created_at integer not null,
  primary key (phone, purpose)
);

-- Passkeys as a sign-in method (a second factor is the 2fa module's).
create table auth__passkeys (
  id            text    primary key,
  credential_id text    not null unique,     -- base64url
  user_id       text    not null references auth__users (id),
  public_key    text    not null,            -- COSE, base64url
  algorithm     integer not null,
  counter       integer not null,
  name          text    not null,
  created_at    integer not null,
  last_used_at  integer
);
create index auth__passkeys_user on auth__passkeys (user_id);

-- WebAuthn challenges: single use, 5 minutes.
create table auth__webauthn_challenges (
  challenge  text    primary key,            -- base64url
  purpose    text    not null check (purpose in ('register', 'login')),
  user_id    text,
  expires_at integer not null,
  used_at    integer
);
