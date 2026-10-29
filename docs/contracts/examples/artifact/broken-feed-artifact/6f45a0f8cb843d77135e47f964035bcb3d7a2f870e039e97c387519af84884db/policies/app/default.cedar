// The app's own policies: finance may read and refund orders of its organisation;
// refunds over 10,000,000 only by finance_manager; the order feed per organisation.
permit (principal in Renox::Role::"finance",
        action in [Renox::Action::"order.read", Renox::Action::"order.refund"],
        resource is App::Order)
when { resource.org_id == principal.org };

forbid (principal, action == Renox::Action::"order.refund", resource)
when { resource.amount > 10000000 } unless { principal in Renox::Role::"finance_manager" };

permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "orders:*" && resource.segments.contains(principal.org) };
