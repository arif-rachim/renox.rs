-- Users: the password is an argon2id PHC string (ctx.password.hash); the
-- email is unique without regard to case.
create table auth__users (
  id text primary key,
  email text not null collate nocase unique,
  display_name text not null,
  password_hash text not null,
  email_verified_at integer,
  created_at integer not null,
  updated_at integer not null
);

-- Sessions: the cookie carries a random token; only its SHA-256 is stored.
create table auth__sessions (
  id text primary key,
  token_hash text not null unique,
  user_id text not null references auth__users (id),
  created_at integer not null,
  last_seen_at integer not null,
  absolute_expires_at integer not null,
  user_agent text,
  revoked_at integer
);
create index auth__sessions_user on auth__sessions (user_id);

-- Other sign-in identities (OAuth providers, #240).
create table auth__identities (
  provider text not null,
  subject text not null,
  user_id text not null references auth__users (id),
  created_at integer not null,
  primary key (provider, subject)
);

-- One-time tokens (magic links, password reset, email verification; #240).
create table auth__tokens (
  id text primary key,
  purpose text not null,
  token_hash text not null unique,
  user_id text references auth__users (id),
  email text,
  expires_at integer not null,
  used_at integer,
  created_at integer not null
);

-- Failure buckets: `acct:<email>` and `ip:<address>`, a count per window.
create table auth__attempts (
  bucket text primary key,
  count integer not null,
  window_start integer not null
);

-- What other modules may read (D17: versioned; never the hash).
create view auth__public_users_v1 as
  select id, email, display_name, created_at from auth__users;
