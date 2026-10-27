-- Products and cart items of the shop example (prices in fils: 1 AED = 100 fils).
create table app__products (
  id          integer primary key,
  name        text    not null,
  description text    not null,
  price_fils  integer not null check (price_fils >= 0),
  stock       integer not null check (stock >= 0),
  category    text    not null,
  image       text    not null
) strict;

create index app__products_category on app__products (category);
create index app__products_name on app__products (name);

create table app__cart_items (
  id         integer primary key,
  cart_id    text    not null,
  product_id integer not null references app__products (id),
  quantity   integer not null check (quantity between 1 and 99),
  created_at integer not null
) strict;

create index app__cart_items_cart on app__cart_items (cart_id);
