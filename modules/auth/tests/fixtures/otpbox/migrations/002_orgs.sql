-- #590: the organisations a user may let an agent act in (stands in for org).
create table otpbox__orgs (user_id text not null, org_id text not null, name text not null, primary key (user_id, org_id));
