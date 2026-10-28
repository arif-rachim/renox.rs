-- Control-plane schema, version 1 (docs/contracts/deploy-api.md; docs/06-data.md
-- "Control plane"). Forward-only: a later change is a new numbered file, never
-- an edit of this one (the runner refuses a changed checksum).
--
-- Times are bigint Unix milliseconds, like every timestamp of the contract.

create table tenants (
  id         text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  name       text not null check (length(name) between 1 and 128),
  tier       text not null check (tier in ('free', 'paid')),
  state      text not null default 'active' check (state in ('active', 'suspended')),
  created_at bigint not null
);

-- Tenant tokens (renox_pat_...). Only the SHA-256 of the value is stored.
create table tokens (
  id           text primary key,
  tenant_id    text not null references tenants (id),
  name         text not null,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  scopes       jsonb not null,
  created_at   bigint not null,
  expires_at   bigint not null,
  last_used_at bigint,
  revoked_at   bigint
);
create index tokens_tenant on tokens (tenant_id);

-- Node tokens (renox_node_...), one per node id.
create table node_tokens (
  node_id      text primary key check (node_id ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at   bigint not null,
  revoked_at   bigint
);

-- Registered worker nodes (deploy-api.md section 7).
create table workers (
  node_id           text primary key references node_tokens (node_id),
  worker_version    text not null,
  region            text not null,
  max_cells         integer not null check (max_cells > 0),
  registered_at     bigint not null,
  last_heartbeat_at bigint not null,
  route_version     bigint not null default 0,
  cells             integer not null default 0,
  healthy           boolean not null default true
);

create table apps (
  name       text primary key check (name ~ '^[a-z][a-z0-9-]{0,49}$'),
  tenant_id  text not null references tenants (id),
  created_at bigint not null
);
create index apps_tenant on apps (tenant_id);

-- Deployments: one per (app, hash); state machine in deploy-api.md section 5.
create table deployments (
  tenant_id       text not null references tenants (id),
  app             text not null references apps (name),
  hash            text not null check (hash ~ '^[0-9a-f]{64}$'),
  state           text not null check (state in ('uploaded', 'validated', 'rejected', 'activating', 'active', 'superseded', 'suspended', 'pruned')),
  created_at      bigint not null,
  updated_at      bigint not null,
  size_bytes      bigint not null default 0,
  manifest        jsonb,
  secrets_version integer,
  activated_at    bigint,
  last_error      jsonb,
  violations      jsonb,
  primary key (app, hash)
);
create index deployments_tenant on deployments (tenant_id);
create unique index deployments_one_active on deployments (app) where state = 'active';
create unique index deployments_one_activating on deployments (app) where state = 'activating';

-- Permissions approved at upload: one row per network host or secret name.
create table permissions (
  tenant_id   text not null references tenants (id),
  app         text not null,
  hash        text not null,
  kind        text not null check (kind in ('network', 'secret')),
  value       text not null,
  approved_at bigint not null,
  primary key (app, hash, kind, value),
  foreign key (app, hash) references deployments (app, hash) on delete cascade
);

-- Envelope encryption (deploy-api.md section 9): per-tenant data key, wrapped
-- by the master key; secret values encrypted with the data key.
create table tenant_keys (
  tenant_id     text primary key references tenants (id),
  wrapped_dek   bytea not null,
  nonce         bytea not null,
  master_key_id text not null,
  created_at    bigint not null
);

-- The app's secret-set version (0 = nothing set yet).
create table secret_sets (
  app       text primary key references apps (name),
  tenant_id text not null references tenants (id),
  version   integer not null default 0 check (version >= 0)
);

-- One row per value: valid from version_from up to (excluding) version_to.
create table secrets (
  tenant_id    text not null references tenants (id),
  app          text not null references apps (name),
  name         text not null check (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  version_from integer not null,
  version_to   integer,
  ciphertext   bytea not null,
  nonce        bytea not null,
  created_at   bigint not null,
  primary key (app, name, version_from),
  check (version_to is null or version_to > version_from)
);

-- Meters (docs/contracts/meter.md): raw records de-duplicated on request_id,
-- and the hourly rollup (#56).
create table meters_raw (
  request_id      text primary key,
  tenant_id       text not null,
  deployment_hash text not null,
  node_id         text not null,
  started_at      bigint not null,
  record          jsonb not null,
  received_at     bigint not null
);
create index meters_raw_tenant_started on meters_raw (tenant_id, started_at);

create table meters_hourly (
  tenant_id        text not null,
  deployment_hash  text not null,
  hour_start       bigint not null,
  requests         bigint not null default 0,
  cpu_ms           double precision not null default 0,
  wall_ms          double precision not null default 0,
  egress_bytes     bigint not null default 0,
  fetch_sent_bytes bigint not null default 0,
  db_ms            double precision not null default 0,
  db_rows          bigint not null default 0,
  render_fuel      bigint not null default 0,
  primary key (tenant_id, deployment_hash, hour_start)
);

-- Append-only audit log (docs/04-isolation-security.md "Operational
-- security"; deploy-api.md section 2). Never holds bodies, values or tokens.
create table audit (
  id         bigint generated always as identity primary key,
  at         bigint not null,
  tenant_id  text,
  actor      text not null,
  action     text not null,
  target     jsonb not null,
  status     integer not null,
  request_id text not null
);
create index audit_tenant_at on audit (tenant_id, at);

create function audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit is append-only';
end
$$;
create trigger audit_no_update before update or delete on audit
  for each row execute function audit_append_only();
