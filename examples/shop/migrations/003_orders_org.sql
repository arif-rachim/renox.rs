-- Orders carry the buyer's active organisation when there is one (the org
-- module, #242: org__public_members_v1.org_id; the shop has no org table).
-- `add column` on the STRICT table works under the migration authorizer
-- since #264 (an earlier version rebuilt the table instead).
alter table app__orders add column org_id text;
create index app__orders_org on app__orders (org_id);
