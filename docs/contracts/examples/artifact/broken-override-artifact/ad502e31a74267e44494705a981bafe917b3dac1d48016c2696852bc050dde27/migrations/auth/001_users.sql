create table auth__users (id text primary key, email text not null unique);
create view auth__public_users_v1 as select id, email from auth__users;
