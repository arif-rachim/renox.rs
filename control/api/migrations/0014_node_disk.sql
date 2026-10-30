-- The disk level each node last reported on its heartbeat (#311;
-- deploy-api.md 0.4 section 7): null until a heartbeat carries `disk` (a
-- worker older than 0.4 never sends it, and getNode answers null).
alter table workers add column disk jsonb;
alter table workers add column disk_reported_at bigint;
