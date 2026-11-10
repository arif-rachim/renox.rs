-- Export kinds (docs/contracts/deploy-api.md 0.8 section 14, #671): the
-- `exports` table also holds the copy of an app's files (`files`) and of a
-- deployment's artifact (`artifact`), next to the database snapshot
-- (`database`, every row before this migration). `hash` is the deployment of
-- an `artifact` export. The expiry, the purge and the erasure delete by
-- `object_key` and do not look at the kind.

alter table exports
  add column kind text not null default 'database' check (kind in ('database', 'files', 'artifact')),
  add column hash text check (hash ~ '^[0-9a-f]{64}$');
