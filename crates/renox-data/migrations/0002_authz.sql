-- Platform tables of authorization (docs/contracts/ops.md 1.5.0 section 17;
-- docs/11-authorization.md; #277). Written through the platform handle
-- only: a module's authorizer refuses every renox__* table.

-- Role assignments, written only by op_authz_roles_assign / _revoke. A
-- tenant-wide assignment has scope_type 'global' and scope_id '' (stored
-- as '' so the unique index holds: SQLite treats NULLs as distinct).
create table if not exists renox__role_assignments (
  user_id    text    not null,
  role       text    not null,
  scope_type text    not null,
  scope_id   text    not null default '',
  granted_by text    not null,
  at         integer not null                -- Unix ms
) strict;
create unique index if not exists renox__role_assignments_key
  on renox__role_assignments (user_id, role, scope_type, scope_id);

-- Decisions on sensitive actions, append-only: the authorizer refuses
-- UPDATE, DELETE, DROP, and ALTER for every connection, the platform's
-- included, and INSERT for every module.
create table if not exists renox__authz_audit (
  id            integer primary key,
  principal     text    not null,            -- principal id, or 'anonymous'
  action        text    not null,
  resource_type text,
  resource_id   text,
  result        text    not null check (result in ('allow', 'deny')),
  policy        text,
  at            integer not null             -- Unix ms
) strict;
create index if not exists renox__authz_audit_at on renox__authz_audit (at);

-- What the audit module (#288) and its dependants read.
create view if not exists renox__authz_audit_v1 as
  select id, principal, action, resource_type, resource_id, result, policy, at
  from renox__authz_audit;
