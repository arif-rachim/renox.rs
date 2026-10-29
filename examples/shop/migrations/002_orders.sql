-- Orders: one per checkout, by the signed-in user (auth__public_users_v1.id;
-- the shop has no user table of its own).
create table app__orders (
  id          integer primary key,
  user_id     text    not null,
  cart_id     text    not null,
  amount_fils integer not null check (amount_fils >= 0),
  created_at  integer not null
) strict;

create index app__orders_user on app__orders (user_id);
