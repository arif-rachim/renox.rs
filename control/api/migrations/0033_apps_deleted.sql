-- Soft delete of one app (#536; docs/contracts/deploy-api.md 0.7 section 3).
-- `deleteApp` sets `deleted_at`: the app is 404 on every app endpoint and
-- absent from `listApps`, while its row keeps the name reserved (`createApp`'s
-- `on conflict (name)` still sees it). `restoreApp` clears it within 7 days;
-- after that the purge (src/apps/purge.ts) deletes the row, and the name goes
-- to quarantine (src/apps/slugs.ts, and the `apps_slug_quarantine` trigger of
-- 0005).
alter table apps add column deleted_at bigint;
create index apps_deleted_at on apps (deleted_at) where deleted_at is not null;
