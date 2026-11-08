// home-services: who may do what (docs/11-authorization.md).
// Roles are role assignments (renox__role_assignments); `principal.org` is the
// session's active organisation, one branch of the company (org module);
// `principal.mfa_verified` comes from the twofa module.

// A signed-in member of the active branch may do what their role allows.
permit (principal in Renox::Role::"owner", action, resource)
when { principal has org };
permit (principal in Renox::Role::"branch_manager", action in [Renox::Action::"customer.read", Renox::Action::"customer.write", Renox::Action::"quote.read", Renox::Action::"quote.write", Renox::Action::"quote.approve", Renox::Action::"job.read", Renox::Action::"job.write", Renox::Action::"job.dispatch", Renox::Action::"visit.perform", Renox::Action::"invoice.read", Renox::Action::"invoice.issue", Renox::Action::"contract.read", Renox::Action::"contract.write", Renox::Action::"report.view"], resource)
when { principal has org };
permit (principal in Renox::Role::"dispatcher", action in [Renox::Action::"customer.read", Renox::Action::"customer.write", Renox::Action::"quote.read", Renox::Action::"quote.write", Renox::Action::"job.read", Renox::Action::"job.write", Renox::Action::"job.dispatch", Renox::Action::"contract.read"], resource)
when { principal has org };
permit (principal in Renox::Role::"technician", action in [Renox::Action::"job.read", Renox::Action::"visit.perform"], resource)
when { principal has org };
permit (principal in Renox::Role::"accountant", action in [Renox::Action::"invoice.read", Renox::Action::"invoice.issue", Renox::Action::"invoice.pay", Renox::Action::"report.view", Renox::Action::"customer.read", Renox::Action::"job.read", Renox::Action::"contract.read"], resource)
when { principal has org };

// A sensitive action needs a recent second factor.
forbid (principal, action in [Renox::Action::"invoice.issue", Renox::Action::"invoice.pay", Renox::Action::"settings.write"], resource)
unless { principal has mfa_verified && principal.mfa_verified };
