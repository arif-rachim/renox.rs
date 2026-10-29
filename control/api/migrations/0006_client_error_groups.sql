-- Browser error groups (docs/contracts/deploy-api.md section 11.1; #128).
--
-- One group per (app, fingerprint): the fingerprint is computed at ingestion
-- from the event kind, the top frame, and the normalised message
-- (src/logs/grouping.ts). Raw frames are kept; the original positions are
-- looked up in the private sourcemaps when a group or event is read.

create table client_error_groups (
  tenant_id          text not null references tenants (id),
  app                text not null references apps (name),
  fingerprint        text not null check (fingerprint ~ '^[0-9a-f]{16}$'),
  kind               text not null,
  -- Message and top frame of the most recent event, and that event's deployment.
  message            text not null,
  top_frame          jsonb,
  top_deployment     text check (top_deployment ~ '^[0-9a-f]{64}$'),
  status             text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  first_seen         bigint not null,
  last_seen          bigint not null,
  count              bigint not null default 0,
  regressed          boolean not null default false,
  -- When resolved: the creation time of the deployment that was active then
  -- (else the time of resolving). An event from a newer deployment reopens the group.
  resolved_after     bigint,
  primary key (app, fingerprint)
);
create index client_error_groups_tenant on client_error_groups (tenant_id, app, last_seen desc);

-- Events per group and deployment: the sparkline of the Logs screen.
create table client_error_deployments (
  tenant_id       text not null references tenants (id),
  app             text not null references apps (name),
  fingerprint     text not null,
  deployment_hash text not null check (deployment_hash ~ '^[0-9a-f]{64}$'),
  count           bigint not null default 0,
  primary key (app, fingerprint, deployment_hash),
  foreign key (app, fingerprint) references client_error_groups (app, fingerprint) on delete cascade
);
create index client_error_deployments_tenant on client_error_deployments (tenant_id, app, deployment_hash);

-- The last 20 events of each group (the rest are pruned at ingestion).
create table client_error_events (
  id              bigserial primary key,
  tenant_id       text not null references tenants (id),
  app             text not null references apps (name),
  fingerprint     text not null,
  ts              bigint not null,
  client_ts       bigint not null,
  deployment_hash text not null check (deployment_hash ~ '^[0-9a-f]{64}$'),
  request_id      text,
  message         text not null,
  url             text not null,
  ua              text not null,
  frames          jsonb not null,
  foreign key (app, fingerprint) references client_error_groups (app, fingerprint) on delete cascade
);
create index client_error_events_group on client_error_events (tenant_id, app, fingerprint, id desc);
