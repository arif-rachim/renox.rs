// The shop's policies (#292; docs/11-authorization.md, the worked example).
// Roles are role assignments (renox__role_assignments); `principal.org` is
// the session's active organisation (the org module's principal filler);
// `principal.mfa_verified` comes from the 2fa module.

// Any signed-in member of an organisation lists their orders there.
permit (principal is Renox::User, action == Renox::Action::"order.list", resource == Renox::Action::"order.list")
when { principal has org };

// Their own orders: read.
permit (principal is Renox::User, action == Renox::Action::"order.read", resource is App::Order)
when { resource.user_id == principal.id };

// Roles, inside the active organisation only.
permit (principal in Renox::Role::"viewer", action == Renox::Action::"order.read", resource is App::Order)
when { principal has org && resource.org_id == principal.org };

permit (principal in Renox::Role::"finance", action in [Renox::Action::"order.read", Renox::Action::"invoice.refund"], resource is App::Order)
when { principal has org && resource.org_id == principal.org };

permit (principal in Renox::Role::"finance_manager", action in [Renox::Action::"order.read", Renox::Action::"invoice.refund"], resource is App::Order)
when { principal has org && resource.org_id == principal.org };

// Over 10,000 AED (1,000,000 fils), only a finance manager refunds.
forbid (principal, action == Renox::Action::"invoice.refund", resource is App::Order)
when { resource.amount_fils > 1000000 }
unless { principal in Renox::Role::"finance_manager" };

// A refund needs a recent second factor.
forbid (principal, action == Renox::Action::"invoice.refund", resource)
unless { principal has mfa_verified && principal.mfa_verified };

// The live orders screen: only the active organisation's topic.
permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "orders:*" && principal has org && resource.segments.contains(principal.org) };
