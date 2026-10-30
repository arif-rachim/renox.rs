-- deploy-api.md 0.5 section 20 (#325): platform billing in AED. One billing
-- row per tenant (plan, tier state, profile, payment method), its invoices,
-- and the PSP events already handled (webhook de-duplication).
create table tenant_billing (
  tenant_id      text   primary key references tenants (id),
  plan           text   not null default 'free',
  pending_plan   text,
  state          text   not null default 'active',
  state_since    bigint not null,
  period_start   bigint not null,
  profile        text,             -- JSON BillingProfile
  payment_method text,             -- JSON PaymentMethod (never card data)
  setup_id       text
);
create table invoices (
  id           text   primary key,
  tenant_id    text   not null references tenants (id),
  period_start bigint not null,
  period_end   bigint not null,
  status       text   not null,
  body         text   not null,    -- JSON Invoice
  issued_at    bigint not null,
  paid_at      bigint
);
create index invoices_tenant on invoices (tenant_id, issued_at);
create table billing_events (
  provider    text   not null,
  event_id    text   not null,
  received_at bigint not null,
  primary key (provider, event_id)
);
