create table app__orders (
  id text primary key,
  user_id text not null,
  org_id text not null,
  amount integer not null,
  status text not null default 'open'
);
create index app__orders_user on app__orders (user_id);
