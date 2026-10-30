-- deploy-api.md 0.5 section 23 (#327): the AI gateway's per-tenant monthly
-- token meter and its answer cache (keyed by tenant and request; never shared
-- across tenants). Requests and answers are not logged; the cache keeps the
-- answer for 24 hours only.
create table ai_usage (
  tenant_id  text   not null references tenants (id),
  month      text   not null,   -- YYYY-MM (UTC)
  tokens_in  bigint not null default 0,
  tokens_out bigint not null default 0,
  primary key (tenant_id, month)
);
create table ai_cache (
  key        text   primary key,  -- sha256(tenant || canonical request)
  tenant_id  text   not null references tenants (id),
  answer     text   not null,
  created_at bigint not null
);
