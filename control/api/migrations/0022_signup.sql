-- deploy-api.md 0.5 section 21 (#326): `dpa_accepted` records the data
-- processing agreement's version and the time it was accepted, on the tenant
-- that sign-up created.
alter table tenants add column dpa_version text;
alter table tenants add column dpa_accepted_at bigint;
