-- Orders carry the buyer's active organisation when there is one (the org
-- module, #242: org__public_members_v1.org_id; the shop has no org table).
--
-- A rebuild, not `alter table ... add column`: on a STRICT table SQLite
-- checks the table with pragma_quick_check, which the authorizer refuses
-- in migrations (finding, #242).
create table app__orders_v2 (
  id          integer primary key,
  user_id     text    not null,
  org_id      text,
  cart_id     text    not null,
  amount_fils integer not null check (amount_fils >= 0),
  created_at  integer not null
) strict;
insert into app__orders_v2 (id, user_id, org_id, cart_id, amount_fils, created_at)
  select id, user_id, null, cart_id, amount_fils, created_at from app__orders;
drop table app__orders;
alter table app__orders_v2 rename to app__orders;
create index app__orders_user on app__orders (user_id);
create index app__orders_org on app__orders (org_id);
