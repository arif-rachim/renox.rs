-- Domain ownership and slug quarantine (#114; docs/24-threat-model.md
-- section C, "Custom domain takeover").
--
-- A hostname is owned by at most one claim in any state but released, so
-- two tenants racing for one hostname cannot both win. A detached claim
-- stays owned for 30 days (detached_at); released_at records the end.
-- detach_reason: 'removed' (the tenant detached it; it stays detached until
-- the tenant adds it again) or 'unverified' (the TXT re-check failed, or the
-- tenant added it again; a later TXT match makes it verified).

alter table domains
  add column detached_at       bigint,
  add column released_at       bigint,
  add column detach_reason     text check (detach_reason in ('removed', 'unverified')),
  add column txt_checked_at    bigint,
  add column next_txt_check_at bigint;

create unique index domains_one_owner on domains (hostname) where state <> 'released';
create index domains_next_txt_check on domains (next_txt_check_at) where state in ('verified', 'detached');

-- App names (the `<app>.renox.app` slugs) nobody may take: reserved words
-- for ever (reserved_slugs(), the same list as RESERVED_SLUGS in
-- src/apps/slugs.ts; a test checks both agree), and the name of a deleted
-- app for 90 days for every tenant but the one that deleted it.
create function reserved_slugs() returns setof text language sql immutable as $$
  select unnest(array[
    'www', 'api', 'app', 'apps', 'admin', 'dashboard', 'console', 'mcp', 'acme', 'edge', 'mail', 'smtp', 'imap', 'pop', 'mx',
    'ns', 'ns1', 'ns2', 'dns', 'cdn', 'static', 'assets', 'status', 'docs', 'help', 'support', 'blog', 'auth', 'login', 'sso',
    'id', 'account', 'accounts', 'billing', 'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'root', 'renox',
    'internal', 'preview', 'staging', 'test', 'dev', 'localhost', 'autodiscover', 'autoconfig', 'wpad'
  ])
$$;

create table quarantined_slugs (
  slug       text primary key check (slug ~ '^[a-z][a-z0-9-]{0,49}$'),
  tenant_id  text not null,
  until      bigint not null,
  created_at bigint not null
);

-- Refuses a reserved or quarantined name by skipping the insert: the API's
-- `insert ... on conflict do nothing returning` then answers 409 "not
-- available", the same answer as for a name in use.
create function apps_slug_available() returns trigger language plpgsql as $$
begin
  if new.name in (select reserved_slugs())
     or exists (select 1 from quarantined_slugs q where q.slug = new.name and q.tenant_id <> new.tenant_id and q.until > new.created_at) then
    return null;
  end if;
  return new;
end
$$;
create trigger apps_slug_available before insert on apps for each row execute function apps_slug_available();

-- A deleted app's name is quarantined for 90 days (QUARANTINE_MS in
-- src/apps/slugs.ts), from the database clock.
create function apps_slug_quarantine() returns trigger language plpgsql as $$
declare
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
begin
  insert into quarantined_slugs (slug, tenant_id, until, created_at)
  values (old.name, old.tenant_id, now_ms + 90::bigint * 86400000, now_ms)
  on conflict (slug) do update set tenant_id = excluded.tenant_id, until = excluded.until, created_at = excluded.created_at;
  return old;
end
$$;
create trigger apps_slug_quarantine after delete on apps for each row execute function apps_slug_quarantine();
