-- deploy-api.md 0.5 section 20 (#325): the anomaly rule's operator review
-- rows. One row per tenant, dimension and hour an anomaly was seen: the
-- hour's value against the tenant's own 7-day hourly median. An operator
-- closes a row (`state`), the tier machine reads the open ones.
create table billing_reviews (
  id          text   primary key,
  tenant_id   text   not null references tenants (id),
  dimension   text   not null,
  hour_start  bigint not null,
  observed    double precision not null,
  median      double precision not null,
  state       text   not null default 'open',
  created_at  bigint not null,
  unique (tenant_id, dimension, hour_start)
);
create index billing_reviews_open on billing_reviews (state, created_at);
