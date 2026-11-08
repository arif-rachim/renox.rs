// home-services: who may do what (docs/11-authorization.md).
// Roles are role assignments (renox__role_assignments); `principal.org` is the
// session's active organisation, one branch of the company (org module);
// `principal.mfa_verified` comes from the twofa module.

// A signed-in member of the active branch may do what their role allows.
permit (principal in Renox::Role::"owner", action, resource)
when { principal has org };
permit (principal in Renox::Role::"branch_manager", action in [Renox::Action::"customer.read", Renox::Action::"customer.write", Renox::Action::"quote.read", Renox::Action::"quote.write", Renox::Action::"quote.approve", Renox::Action::"job.read", Renox::Action::"job.write", Renox::Action::"job.dispatch", Renox::Action::"visit.perform", Renox::Action::"invoice.read", Renox::Action::"contract.read", Renox::Action::"contract.write", Renox::Action::"report.view"], resource)
when { principal has org };
permit (principal in Renox::Role::"dispatcher", action in [Renox::Action::"customer.read", Renox::Action::"customer.write", Renox::Action::"quote.read", Renox::Action::"quote.write", Renox::Action::"job.read", Renox::Action::"job.write", Renox::Action::"job.dispatch", Renox::Action::"contract.read", Renox::Action::"contract.write"], resource)
when { principal has org };
permit (principal in Renox::Role::"technician", action in [Renox::Action::"job.read", Renox::Action::"visit.perform"], resource)
when { principal has org };
permit (principal in Renox::Role::"accountant", action in [Renox::Action::"invoice.read", Renox::Action::"invoice.issue", Renox::Action::"invoice.pay", Renox::Action::"report.view", Renox::Action::"customer.read", Renox::Action::"job.read", Renox::Action::"contract.read"], resource)
when { principal has org };

// The reports of the `reports` module (its page at /reports) and the app's own
// reports under /reports/*: the owner (the blanket permit above) and the
// accountant. The module's default policy grants them to its own admin and
// finance roles only. reports.export is sensitive in the module (each decision
// is audited); it carries customers and amounts out of the app.
permit (principal in Renox::Role::"accountant", action in [Renox::Action::"reports.view", Renox::Action::"reports.export"], resource)
when { principal has org };

// A technician reads only their own jobs: `mine` is computed per job
// (lib/jobs.ts jobResource). The route guards check `job.read` without a job.
forbid (principal in Renox::Role::"technician", action == Renox::Action::"job.read", resource is App::Job)
unless { resource.mine == "yes" };

// A visit is performed by the technician whose job it is, whatever else their
// role allows (an owner or a manager does not check in to someone else's job).
// The route guards check `visit.perform` without a job.
forbid (principal, action == Renox::Action::"visit.perform", resource is App::Job)
unless { resource.mine == "yes" };

// Dispatching is per branch: the dispatch socket's guard names the branch by
// its slug, and only a member of its organisation (the session's active one) passes.
forbid (principal, action == Renox::Action::"job.dispatch", resource is App::Branch)
unless { principal has org && resource.org_id == principal.org };

// The dispatch board: dispatchers, branch managers and owners subscribe to
// `jobs:<branch id>`. The socket subscribes only after its guard let the branch in.
permit (principal in Renox::Role::"owner", action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "jobs:*" };
permit (principal in Renox::Role::"branch_manager", action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "jobs:*" };
permit (principal in Renox::Role::"dispatcher", action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "jobs:*" };

// Dispatchers (and above) manage the booking catalogue the app mirrors
// (lib/booking-sync.ts calls addService, addStaff and setHours as the signed-in user).
permit (principal in Renox::Role::"owner", action == Renox::Action::"booking.manage", resource);
permit (principal in Renox::Role::"branch_manager", action == Renox::Action::"booking.manage", resource);
permit (principal in Renox::Role::"dispatcher", action == Renox::Action::"booking.manage", resource);

// App MCP tools (functions/tools): an agent runs as the user whose token it
// holds. A token has no session, so its principal has no `org` (org sets it from
// the session's active organisation) and NO ROLES: the cell adds the role
// assignments to a session's principal only, and auth's verifyAgentToken gives
// none. So the policies above, which are all about roles, deny every tool call.
// Two things stand in for them:
//  - the cell's check of a tool's `action` (before `run`) passes a signed-in
//    token's user for the two read and write actions, as long as the evaluation
//    names no roles. A token's principal is told from a session's by its
//    attributes: `email_verified` (a user, not the anonymous visitor) and no
//    `created_at` (auth.principal sets it for sessions and verifyAgentToken does
//    not). Pages and `r-can` evaluations name no roles either, so this must not
//    match a session: it does not;
//  - inside `run`, lib/tools.ts reads the user's roles for the branch from
//    renox__role_assignments (ctx.authz.roles) and asks `can` with them in
//    `context.staff_roles`; the permits below decide, and the cases of
//    policies/tests/tools.json pin them. Only app code names `staff_roles`.
permit (principal, action in [Renox::Action::"job.read", Renox::Action::"job.write"], resource)
when { principal has email_verified && principal.email_verified && !(principal has created_at) && !(context has staff_roles) };
permit (principal, action in [Renox::Action::"job.read", Renox::Action::"job.write", Renox::Action::"job.dispatch", Renox::Action::"booking.manage"], resource)
when { context has staff_roles && (context.staff_roles.contains("owner") || context.staff_roles.contains("branch_manager") || context.staff_roles.contains("dispatcher")) };
permit (principal, action == Renox::Action::"job.read", resource)
when { context has staff_roles && (context.staff_roles.contains("technician") || context.staff_roles.contains("accountant")) };

// A technician's token reads only their own jobs, as a technician's session does.
forbid (principal, action == Renox::Action::"job.read", resource is App::Job)
when { context has staff_roles && context.staff_roles.contains("technician") }
unless { resource.mine == "yes" };

// A sensitive action needs a recent second factor.
forbid (principal, action in [Renox::Action::"invoice.issue", Renox::Action::"invoice.pay", Renox::Action::"settings.write", Renox::Action::"user.manage"], resource)
unless { principal has mfa_verified && principal.mfa_verified };
