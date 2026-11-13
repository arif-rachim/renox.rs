-- Sign-up by phone (#773): a phone with no account gets a one-time code, and
-- verifying it creates the account (no email, no password).
--
-- Such a user keeps `auth__users.email` (not null, unique) and `password_hash`
-- (not null) filled with sentinels that no sign-in path accepts: the email is
-- `!phone:<id>` (it has no `@`, so no address matches it and none can register
-- it) and the hash is `!phone` (not an argon2id string, so no password
-- verifies; oauth users do the same with `!oauth`). The public view shows an
-- empty email for them.

-- Pending codes for a phone that has no account: the same shape as
-- auth__phone_codes, without a user. One row per phone.
create table auth__phone_signups (
  phone      text    primary key,
  code_hash  text    not null,
  expires_at integer not null,
  attempts   integer not null default 0,
  created_at integer not null
);

-- Same columns as v1: the sentinel email shows as ''. Never the hash.
drop view auth__public_users_v1;
create view auth__public_users_v1 as
  select id, case when email like '!phone:%' then '' else email end as email, display_name, created_at from auth__users;
