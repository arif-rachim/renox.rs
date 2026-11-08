-- The back office (F7-128): the app role an invited person gets in a branch.
-- `org` keeps the invitation (its role is member, admin or owner); the five
-- app roles are the app's own, so the owner's choice waits here until the
-- person has joined (lib/admin.ts claimInvites). Owned by the branch like
-- every other table that carries its own branch_id.
create table app__staff_invites (
  id integer primary key autoincrement,
  branch_id text not null references app__branches (id),
  org_id text not null,
  email text not null collate nocase,
  role text not null check (role in ('owner', 'branch_manager', 'dispatcher', 'technician', 'accountant')),
  invited_by text not null,
  created_at integer not null,
  applied_at integer
);
create index app__staff_invites_email on app__staff_invites (email, applied_at);
