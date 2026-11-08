-- Rename one app (#537; docs/contracts/deploy-api.md 0.7 section 3).
--
-- `apps.name` is the primary key and the key of every row of the app. The
-- foreign keys to it (and the composite keys that repeat it: permissions to
-- deployments, client error deployments and events to their group) get
-- `on update cascade`, so `update apps set name = ...` moves every
-- referencing row in the same statement, and a table cannot be forgotten.
-- `app_modules` and `deployment_advisories` hold the name without a foreign
-- key; src/apps/rename.ts updates them in the same transaction.

alter table deployments drop constraint deployments_app_fkey,
  add constraint deployments_app_fkey foreign key (app) references apps (name) on update cascade;
alter table permissions drop constraint permissions_app_hash_fkey,
  add constraint permissions_app_hash_fkey foreign key (app, hash) references deployments (app, hash) on update cascade on delete cascade;
alter table secret_sets drop constraint secret_sets_app_fkey,
  add constraint secret_sets_app_fkey foreign key (app) references apps (name) on update cascade;
alter table secrets drop constraint secrets_app_fkey,
  add constraint secrets_app_fkey foreign key (app) references apps (name) on update cascade;
alter table route_entries drop constraint route_entries_app_fkey,
  add constraint route_entries_app_fkey foreign key (app) references apps (name) on update cascade;
alter table domains drop constraint domains_app_fkey,
  add constraint domains_app_fkey foreign key (app) references apps (name) on update cascade;
alter table client_error_groups drop constraint client_error_groups_app_fkey,
  add constraint client_error_groups_app_fkey foreign key (app) references apps (name) on update cascade;
-- The two children of a group reach it through the group's key only; their
-- own key to `apps` would be a second cascade path to the same column.
alter table client_error_deployments drop constraint client_error_deployments_app_fkey,
  drop constraint client_error_deployments_app_fingerprint_fkey,
  add constraint client_error_deployments_app_fingerprint_fkey foreign key (app, fingerprint) references client_error_groups (app, fingerprint) on update cascade on delete cascade;
alter table client_error_events drop constraint client_error_events_app_fkey,
  drop constraint client_error_events_app_fingerprint_fkey,
  add constraint client_error_events_app_fingerprint_fkey foreign key (app, fingerprint) references client_error_groups (app, fingerprint) on update cascade on delete cascade;
alter table exports drop constraint exports_app_fkey,
  add constraint exports_app_fkey foreign key (app) references apps (name) on update cascade;

-- The hint of a renamed app (`getApp`'s 404 for the old name carries
-- `renamed_to`, so `renox deploy` from a `renox.toml` with the old name stops
-- instead of creating a new app). Kept per tenant for the quarantine of the
-- old name (90 days); only the renaming tenant's requests read it.
create table app_renames (
  tenant_id  text   not null references tenants (id),
  old_name   text   not null check (old_name ~ '^[a-z][a-z0-9-]{0,49}$'),
  new_name   text   not null check (new_name ~ '^[a-z][a-z0-9-]{0,49}$'),
  renamed_at bigint not null,
  until      bigint not null,
  primary key (tenant_id, old_name)
);

-- The slug rules of 0005 and 0028 for a rename: an update of `apps.name` to a
-- reserved name (unless the tenant is the platform tenant) or to a name
-- another tenant has in quarantine is skipped, so `renameApp` answers 409
-- "not available", the answer `createApp` gives. The time is the API's clock
-- (`renox.now`, set by src/apps/rename.ts for its transaction), else the
-- database's.
create function apps_slug_rename() returns trigger language plpgsql as $$
declare
  now_ms bigint := coalesce(nullif(current_setting('renox.now', true), '')::bigint, (extract(epoch from clock_timestamp()) * 1000)::bigint);
begin
  if (new.name in (select reserved_slugs()) and not exists (select 1 from tenants t where t.id = new.tenant_id and t.platform))
     or exists (select 1 from quarantined_slugs q where q.slug = new.name and q.tenant_id <> new.tenant_id and q.until > now_ms) then
    return null;
  end if;
  return new;
end
$$;
create trigger apps_slug_rename before update of name on apps for each row when (old.name is distinct from new.name) execute function apps_slug_rename();
