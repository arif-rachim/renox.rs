-- deploy-api.md 0.5.1 section 20 (#350): the Stripe Customer of each tenant,
-- which the saved card is attached to, and the off-session collection of
-- each invoice: the attempts, the last one's time, its PaymentIntent and the
-- decline code. None of it is part of the Invoice body.
alter table tenant_billing add column stripe_customer text;
alter table invoices add column charge_attempts integer not null default 0;
alter table invoices add column charged_at bigint;
alter table invoices add column payment_intent text;
alter table invoices add column decline_code text;
create index invoices_payment_intent on invoices (payment_intent);
