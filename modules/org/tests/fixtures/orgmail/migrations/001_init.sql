create table orgmail__sent (seq integer primary key, mail_to text not null, template text not null, url text not null, org_name text not null);
create table orgmail__events (seq integer primary key, name text not null, org_id text not null, user_id text not null, role text);
