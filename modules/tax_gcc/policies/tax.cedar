// Default policy of the tax_gcc module (#331): an admin or the finance role
// reads tax documents and the VAT return and downloads them. The app grants
// the roles; tax.manage is sensitive, so each decision is audited.
permit (principal in Renox::Role::"admin", action == Renox::Action::"tax.manage", resource);
permit (principal in Renox::Role::"finance", action == Renox::Action::"tax.manage", resource);
