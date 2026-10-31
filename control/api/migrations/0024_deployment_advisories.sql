-- deploy-api.md 0.5 section 11.2 (#123): the OSV advisories of a
-- deployment's `sbom.cdx.json`, looked up when the upload is validated. A
-- warning only: no deployment state depends on it. `sbom` is false for an
-- artifact without one (and `items` empty).
create table deployment_advisories (
  tenant_id  text    not null,
  app        text    not null,
  hash       text    not null,
  sbom       boolean not null,
  items      jsonb   not null default '[]'::jsonb,
  checked_at bigint  not null,
  primary key (tenant_id, app, hash)
);
