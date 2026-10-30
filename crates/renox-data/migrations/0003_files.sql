-- Platform table of stored files (docs/contracts/ops.md 1.7.0 section 21;
-- #321). Written through the platform handle only: a module's authorizer
-- refuses every renox__* table. The bytes are in the platform's object
-- store under tenants/<tenant_id>/files/<key>; this is their metadata, the
-- quota sum, and the lookup of /_img and /_files.
create table if not exists renox__files (
  key          text    not null primary key,  -- <module>/<path>, ops.md section 21
  module       text    not null,              -- the owning module (app for the app)
  bytes        integer not null,
  content_type text    not null,
  sha256       text    not null,
  width        integer,                       -- images only
  height       integer,
  public       integer not null default 0,    -- 1: /_img and /_files serve it unsigned
  created_at   integer not null               -- Unix ms
) strict;
create index if not exists renox__files_module on renox__files (module, key);
