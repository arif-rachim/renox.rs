-- Backups, export, import, restore to a new app (docs/contracts/deploy-api.md
-- 0.3 sections 3 and 14, #258).

-- An app with a database of its own (`<tenant_id>.<app>`): a staging app,
-- or an app created by a restore. Null: the tenant's shared file.
alter table apps add column staging boolean not null default false;
alter table apps add column database text;
alter table route_entries add column database text;

-- Exports: one consistent snapshot per row, under the private prefix
-- exports/<tenant_id>/<database>/<created_at>.db; the row lets a signed URL
-- be checked and the object be deleted after a day.
create table exports (
  id         text primary key,
  tenant_id  text not null references tenants (id),
  app        text not null references apps (name),
  object_key text not null,
  sha256     text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null,
  created_at bigint not null,
  expires_at bigint not null
);
create index exports_tenant on exports (tenant_id, created_at desc);
