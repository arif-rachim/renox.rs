-- Two-step verification (#287). TOTP secrets are sealed (AES-GCM, key
-- from TWOFA_KEY); recovery codes and pending tokens are stored hashed.
create table twofa__totp (
  user_id       text    primary key,
  secret_sealed text    not null,
  confirmed_at  integer,                 -- null until the first code
  last_step     integer,                 -- the last accepted step: replays refused
  created_at    integer not null
) strict;

create table twofa__webauthn (
  id            text    primary key,
  user_id       text    not null,
  credential_id text    not null unique,
  public_key    text    not null,
  algorithm     integer not null,
  counter       integer not null,
  name          text    not null,
  created_at    integer not null
) strict;
create index twofa__webauthn_user on twofa__webauthn (user_id);

create table twofa__recovery (
  user_id    text    not null,
  code_hash  text    not null,
  used_at    integer,
  created_at integer not null,
  primary key (user_id, code_hash)
) strict;

-- auth's session id -> when it passed the second factor.
create table twofa__sessions (
  session_id  text    primary key,
  user_id     text    not null,
  verified_at integer not null,           -- Unix ms
  method      text    not null check (method in ('totp', 'passkey', 'recovery'))
) strict;

-- A sign-in waiting for the second factor: auth's resume ticket, sealed.
create table twofa__pending (
  token_hash    text    primary key,
  user_id       text    not null,
  resume_sealed text    not null,
  next          text,
  attempts      integer not null default 0,
  expires_at    integer not null           -- Unix ms
) strict;

create table twofa__challenges (
  challenge  text    primary key,
  purpose    text    not null check (purpose in ('register', 'verify')),
  user_id    text    not null,
  expires_at integer not null,
  used_at    integer
) strict;

create table twofa__attempts (
  bucket       text    primary key,
  count        integer not null,
  window_start integer not null
) strict;
