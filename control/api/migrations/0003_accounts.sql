-- Control-plane accounts (#113; docs/24-threat-model.md section E): users,
-- email tokens, sessions, memberships with a role per tenant, invitations,
-- owner transfers, known devices, the CLI device flow, and the token and
-- audit columns that bind a token to the user who created it.
--
-- Every secret-bearing value (session, email token, invitation, device code)
-- is stored as its SHA-256 only, like tenant tokens in 0001.

create table users (
  id                text primary key,
  email             text not null check (email = lower(email) and length(email) between 3 and 254),
  password_hash     text not null,
  email_verified_at bigint,
  created_at        bigint not null
);
create unique index users_email on users (email);

-- Single-use tokens sent by email: address verification and password reset.
create table email_tokens (
  id           text primary key,
  user_id      text not null references users (id),
  purpose      text not null check (purpose in ('verify', 'reset')),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at   bigint not null,
  expires_at   bigint not null,
  used_at      bigint
);
create index email_tokens_user on email_tokens (user_id, purpose);

-- Dashboard sessions. A session is bound to one tenant at a time (null until
-- the user belongs to one); switching tenant is an update of the row.
create table sessions (
  id           text primary key,
  user_id      text not null references users (id),
  tenant_id    text references tenants (id),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at   bigint not null,
  last_seen_at bigint not null,
  expires_at   bigint not null,
  revoked_at   bigint,
  ip           text,
  user_agent   text
);
create index sessions_user on sessions (user_id);

create table memberships (
  tenant_id  text not null references tenants (id),
  user_id    text not null references users (id),
  role       text not null check (role in ('owner', 'admin', 'developer', 'viewer')),
  created_at bigint not null,
  primary key (tenant_id, user_id)
);
create unique index memberships_one_owner on memberships (tenant_id) where role = 'owner';
create index memberships_user on memberships (user_id);

create table invitations (
  id           text primary key,
  tenant_id    text not null references tenants (id),
  email        text not null,
  role         text not null check (role in ('admin', 'developer', 'viewer')),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  invited_by   text not null references users (id),
  created_at   bigint not null,
  expires_at   bigint not null,
  accepted_at  bigint,
  revoked_at   bigint
);
create index invitations_tenant on invitations (tenant_id);

-- Owner transfer: proposed by the owner, accepted by the new owner.
create table owner_transfers (
  id          text primary key,
  tenant_id   text not null references tenants (id),
  from_user   text not null references users (id),
  to_user     text not null references users (id),
  created_at  bigint not null,
  expires_at  bigint not null,
  accepted_at bigint,
  revoked_at  bigint
);
create unique index owner_transfers_one_open on owner_transfers (tenant_id) where accepted_at is null and revoked_at is null;

-- Browsers a user has signed in from (SHA-256 of the device cookie), for the
-- new-device email.
create table known_devices (
  user_id       text not null references users (id),
  device_sha256 text not null check (device_sha256 ~ '^[0-9a-f]{64}$'),
  first_seen_at bigint not null,
  primary key (user_id, device_sha256)
);

-- `renox login`: OAuth-style device authorization. The CLI holds the device
-- code; the user approves the user code from a signed-in session.
create table device_codes (
  id            text primary key,
  device_sha256 text not null unique check (device_sha256 ~ '^[0-9a-f]{64}$'),
  user_code     text not null,
  created_at    bigint not null,
  expires_at    bigint not null,
  tenant_id     text references tenants (id),
  user_id       text references users (id),
  scopes        jsonb,
  name          text,
  approved_at   bigint,
  used_at       bigint
);
create unique index device_codes_user_code on device_codes (user_code) where used_at is null;

-- A token created by a user acts with at most that user's current role.
alter table tokens add column user_id text references users (id);
alter table tokens add column last_used_ip text;

alter table audit add column ip text;
