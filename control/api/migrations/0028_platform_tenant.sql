-- #396: the platform tenant, the one that runs the platform's own apps
-- (`control/dashboard` as `dashboard`, `www/` as `www`). Only that tenant may
-- take a reserved app name, and the new-tenant restrictions of deploy-api.md
-- 0.5 section 21 (reduced_quotas, no_custom_domain) do not apply to it. The
-- flag is set only by the operator endpoint POST /v1/ops/tenants/{id}/platform
-- (src/ops/platform.ts), audited with a reason. At most one tenant holds it.
alter table tenants add column platform boolean not null default false;
create unique index tenants_one_platform on tenants ((true)) where platform;

-- The reserved-name rule of 0005, with the platform tenant's exemption. A
-- quarantined name stays refused for every tenant but the one that deleted
-- it, the platform tenant included.
create or replace function apps_slug_available() returns trigger language plpgsql as $$
begin
  if (new.name in (select reserved_slugs()) and not exists (select 1 from tenants t where t.id = new.tenant_id and t.platform))
     or exists (select 1 from quarantined_slugs q where q.slug = new.name and q.tenant_id <> new.tenant_id and q.until > new.created_at) then
    return null;
  end if;
  return new;
end
$$;
