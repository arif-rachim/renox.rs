-- Route table and its change log (docs/contracts/deploy-api.md section 8).
--
-- Every change of an entry takes the next value of route_version_seq; a
-- transaction that changes routes first takes advisory lock 8 so versions
-- commit in increasing order, and a reader of route_changes never skips a
-- version that commits later.

create sequence route_version_seq start 1;

-- The current table: one row per (hostname, deployment_hash).
create table route_entries (
  hostname        text not null,
  deployment_hash text not null,
  tenant_id       text not null references tenants (id),
  app             text not null references apps (name),
  status          text not null check (status in ('active', 'draining')),
  updated_at      bigint not null,
  version         bigint not null,
  tier            text not null check (tier in ('free', 'paid')),
  node_id         text not null,
  secrets_version integer not null,
  primary key (hostname, deployment_hash)
);
create unique index route_entries_one_active on route_entries (hostname) where status = 'active';
create index route_entries_tenant on route_entries (tenant_id);

-- Every upsert and removal, by version: the source of deltas.
create table route_changes (
  version         bigint primary key,
  kind            text not null check (kind in ('upsert', 'remove')),
  hostname        text not null,
  deployment_hash text not null,
  entry           jsonb,
  at              bigint not null
);
