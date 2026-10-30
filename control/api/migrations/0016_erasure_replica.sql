-- deploy-api.md 0.4.1 section 3 (#308, #315): when the owning node confirmed
-- the purge of the tenant's replica (`nodeDropTenant?purge_replica=true`).
alter table tenant_erasures add column replica_purged_at bigint;
