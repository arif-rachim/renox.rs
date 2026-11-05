-- The process isolation each node last reported on its heartbeat (#460;
-- deploy-api.md 0.6.2 section 7): `{ enabled, own_ignored }`, null when the
-- last heartbeat did not carry it (a worker older than 0.6.2), which getNode
-- answers as null and getOpsTenant as `process_effective: unknown`.
alter table workers add column process_isolation jsonb;
alter table workers add column process_isolation_reported_at bigint;
