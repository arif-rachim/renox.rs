-- The billing module (#351): a dispute (chargeback) opened on a paid invoice
-- or one-off order, found through its payment intent.
alter table billing__invoices add column disputed_at integer;
alter table billing__invoices add column dispute_reason text;
