-- Organisations (#242; docs/18-build-plan.md M2). Users are auth's
-- (auth__public_users_v1.id); org keeps no user table of its own.
create table org__orgs (
  id text primary key,
  slug text not null collate nocase unique,
  name text not null,
  created_by text not null,
  created_at integer not null
);

-- One row per member: the role decides what the member may do in the org.
create table org__members (
  org_id text not null references org__orgs (id),
  user_id text not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at integer not null,
  primary key (org_id, user_id)
);
create index org__members_user on org__members (user_id);

-- Invitations: only the SHA-256 of the token is stored; single use, 7 days.
create table org__invites (
  id text primary key,
  org_id text not null references org__orgs (id),
  token_hash text not null unique,
  email text not null collate nocase,
  role text not null check (role in ('owner', 'admin', 'member')),
  invited_by text not null,
  expires_at integer not null,
  accepted_at integer,
  accepted_by text,
  revoked_at integer,
  created_at integer not null
);
create index org__invites_org on org__invites (org_id);

-- The active organisation of an auth session (auth's currentSession id).
create table org__active (
  session_id text primary key,
  org_id text not null references org__orgs (id),
  updated_at integer not null
);

-- What other modules may read (D17: versioned).
create view org__public_members_v1 as
  select org_id, user_id, role from org__members;
