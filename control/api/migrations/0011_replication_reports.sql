-- The replication each database's owning node last reported (deploy-api.md
-- 0.3.1 section 17, getOpsTenant; #296): written whenever the API reads a
-- node's replication status (getBackups), read by getOpsTenant, which never
-- calls a node.
create table replication_reports (
  tenant_id   text   not null references tenants (id),
  database    text   not null,
  node_id     text   not null,
  report      jsonb  not null,
  reported_at bigint not null,
  primary key (tenant_id, database)
);
