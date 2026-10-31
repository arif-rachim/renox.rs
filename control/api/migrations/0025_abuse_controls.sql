-- deploy-api.md 0.5 sections 11.2, 22 (#123): the last Safe Browsing verdict
-- of each served hostname (activation, daily, and an abuse report); the
-- takedown SLA of a phishing or malware ticket (due 4 h after the report,
-- breached once); and the SBOM document of a deployment, kept for the daily
-- OSV re-scan of active deployments.
create table safe_browsing_checks (
  hostname   text   primary key,
  tenant_id  text   not null,
  verdict    text   not null check (verdict in ('safe', 'unsafe', 'unknown')),
  threats    jsonb  not null default '[]'::jsonb,
  checked_at bigint not null
);
create index safe_browsing_checks_tenant on safe_browsing_checks (tenant_id);
create index safe_browsing_checks_at on safe_browsing_checks (checked_at);

alter table abuse_tickets add column sla_due_at bigint;
alter table abuse_tickets add column sla_breached_at bigint;
create index abuse_tickets_sla on abuse_tickets (sla_due_at) where sla_breached_at is null;
create index abuse_tickets_hostname on abuse_tickets (hostname, state);

alter table deployment_advisories add column sbom_doc text;
