-- deploy-api.md 0.5 section 19 (#324): the module registry. Publishers,
-- their Ed25519 keys and the published versions are a catalog shared by
-- every tenant (src/tenancy/scope.ts PLATFORM_TABLES); the approval of a
-- version for an app is the tenant's own row.
create table registry_publishers (
  name       text   primary key,
  tenant_id  text   not null references tenants (id),
  created_at bigint not null
);
create table registry_keys (
  key_id     text   primary key,
  publisher  text   not null references registry_publishers (name),
  added_at   bigint not null,
  revoked_at bigint
);
create table registry_versions (
  publisher       text   not null references registry_publishers (name),
  name            text   not null,
  version         text   not null,
  hash            text   not null,
  key_id          text   not null,
  signature       text   not null,
  description     text,
  isolation       text   not null,
  permissions     text   not null,  -- JSON: manifest.md section 2 [permissions]
  migration_files text   not null,  -- JSON array
  template_files  text   not null,  -- JSON array of pages/ and partials/ files
  price           text,             -- JSON or null
  published_at    bigint not null,
  disabled_at     bigint,
  disabled_reason text,
  primary key (publisher, name, version)
);
create index registry_versions_hash on registry_versions (hash);
create table app_modules (
  tenant_id   text   not null references tenants (id),
  app         text   not null,
  name        text   not null,
  source      text   not null,
  version     text   not null,
  hash        text   not null,
  approved    text   not null,  -- JSON
  approved_at bigint not null,
  approved_by text,
  primary key (tenant_id, app, name)
);
