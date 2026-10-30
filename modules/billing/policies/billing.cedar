// Default policies of the billing module (#329): an admin manages billing
// and refunds; the finance role sees every customer's invoices but cannot
// refund. The app grants the roles; the module never grants them itself.
// billing.refund is sensitive: every decision is a row of renox__authz_audit.
permit (
  principal in Renox::Role::"admin",
  action in [Renox::Action::"billing.manage", Renox::Action::"billing.refund"],
  resource
);
permit (
  principal in Renox::Role::"finance",
  action == Renox::Action::"billing.manage",
  resource
);
