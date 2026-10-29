-- Custom domains and their certificates (docs/contracts/deploy-api.md
-- section 10; docs/05-tenant-lifecycle.md "Custom domains and DNS"; #59).
--
-- A row is one claim of a hostname by one app. Released rows stay as
-- history; a hostname can be claimed again once its row is released.

create table domains (
  id              text primary key,
  hostname        text not null check (hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' and length(hostname) <= 253),
  tenant_id       text not null references tenants (id),
  app             text not null references apps (name),
  state           text not null check (state in ('pending', 'verified', 'detached', 'released')),
  -- The TXT value the tenant creates at _renox-verify.<hostname>.
  verify_token    text not null check (verify_token ~ '^rnx-verify-[0-9a-z]{26}$'),
  -- Whether the hostname points at the edge (CNAME or addresses).
  dns             text not null default 'pending' check (dns in ('pending', 'ok', 'not_pointing')),
  cert_state      text not null default 'none' check (cert_state in ('none', 'issuing', 'issued', 'failed')),
  created_at      bigint not null,
  verified_at     bigint,
  last_checked_at bigint,
  -- When the job looks at this row next (verification poll, DNS check).
  next_check_at   bigint not null,
  -- Certificate orders: the next allowed attempt after a failure, and the count.
  cert_retry_at   bigint,
  cert_failures   integer not null default 0
);
create index domains_tenant_app on domains (tenant_id, app);
create index domains_hostname on domains (hostname);
create index domains_next_check on domains (next_check_at) where state in ('pending', 'verified');

-- The platform's own data key (deploy-api.md section 10: certificates and
-- keys are encrypted like secrets, section 9, with a DEK that belongs to no
-- tenant). Wrapped by the master key.
create table platform_keys (
  id            text primary key,
  wrapped_dek   bytea not null,
  nonce         bytea not null,
  master_key_id text not null,
  created_at    bigint not null
);

-- Versions of certificate_update and certificate_remove: one increasing
-- sequence for every hostname, so a node can order any two messages about
-- one hostname, also across a release and a new claim.
create sequence certificate_version_seq start 1;

-- The latest certificate per hostname. The chain and the key are encrypted
-- with the platform DEK; the associated data binds them to hostname and
-- version.
create table certificates (
  hostname        text primary key,
  version         integer not null check (version >= 1),
  not_after       bigint not null,
  chain_cipher    bytea not null,
  chain_nonce     bytea not null,
  key_cipher      bytea not null,
  key_nonce       bytea not null,
  issued_at       bigint not null
);

-- The ACME account per directory URL; its key encrypted with the platform DEK.
create table acme_accounts (
  directory_url text primary key,
  kid           text not null,
  key_cipher    bytea not null,
  key_nonce     bytea not null,
  created_at    bigint not null
);
