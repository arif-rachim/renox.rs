// home-services: who may do what (docs/11-authorization.md).
// Roles are role assignments (renox__role_assignments); `principal.org` is the
// session's active organisation, one branch of the company (org module);
// `principal.mfa_verified` comes from the twofa module.

// A signed-in member of the active branch may do what their role allows.
permit (principal in Renox::Role::"owner", action, resource)
when { principal has org };
permit (principal in Renox::Role::"branch_manager", action in [Renox::Action::"customer.read", Renox::Action::"customer.write", Renox::Action::"quote.read", Renox::Action::"quote.write", Renox::Action::"quote.approve", Renox::Action::"job.read", Renox::Action::"job.write", Renox::Action::"job.dispatch", Renox::Action::"visit.perform", Renox::Action::"invoice.read", Renox::Action::"contract.read", Renox::Action::"contract.write", Renox::Action::"report.view", Renox::Action::"part.read", Renox::Action::"part.write", Renox::Action::"stock.read", Renox::Action::"stock.move", Renox::Action::"purchase.read", Renox::Action::"purchase.write"], resource)
when { principal has org };
permit (principal in Renox::Role::"dispatcher", action in [Renox::Action::"customer.read", Renox::Action::"customer.write", Renox::Action::"quote.read", Renox::Action::"quote.write", Renox::Action::"job.read", Renox::Action::"job.write", Renox::Action::"job.dispatch", Renox::Action::"contract.read", Renox::Action::"contract.write", Renox::Action::"part.read", Renox::Action::"stock.read"], resource)
when { principal has org };
permit (principal in Renox::Role::"technician", action in [Renox::Action::"job.read", Renox::Action::"visit.perform", Renox::Action::"part.read"], resource)
when { principal has org };
permit (principal in Renox::Role::"accountant", action in [Renox::Action::"invoice.read", Renox::Action::"invoice.issue", Renox::Action::"invoice.pay", Renox::Action::"report.view", Renox::Action::"customer.read", Renox::Action::"job.read", Renox::Action::"contract.read", Renox::Action::"part.read", Renox::Action::"stock.read", Renox::Action::"purchase.read"], resource)
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

// App MCP tools (functions/tools): an agent token's principal carries the
// user's roles and the organisation of the consent (like a session's), so the
// role policies above decide a tool's action and the tools ask ctx.authz.can
// as the pages do; policies/tests/tools.json pins them. A technician's token
// reads only their own jobs through the technician forbid above.

// A sensitive action needs a recent second factor (twofa.reset, #735: the
// twofa module asks for one again itself, before it deletes anything).
forbid (principal, action in [Renox::Action::"invoice.issue", Renox::Action::"invoice.pay", Renox::Action::"settings.write", Renox::Action::"user.manage", Renox::Action::"twofa.reset"], resource)
unless { principal has mfa_verified && principal.mfa_verified };

// The customer portal (/my, #774): a phone-only user holds the global role
// `customer` (lib/portal.ts assigns it) and may use `portal.*` only. The
// forbid is explicit, so a later role mistake cannot open a staff page to a
// customer: every staff action of the app and of the modules' staff pages is
// named. A user who also holds a staff role is treated as staff by the app
// (portalUser returns null for them and never assigns the role).
permit (principal in Renox::Role::"customer", action in [Renox::Action::"portal.view", Renox::Action::"portal.book", Renox::Action::"portal.change"], resource);
forbid (principal in Renox::Role::"customer", action in [Renox::Action::"customer.read", Renox::Action::"customer.write", Renox::Action::"quote.read", Renox::Action::"quote.write", Renox::Action::"quote.approve", Renox::Action::"job.read", Renox::Action::"job.write", Renox::Action::"job.dispatch", Renox::Action::"visit.perform", Renox::Action::"invoice.read", Renox::Action::"invoice.issue", Renox::Action::"invoice.pay", Renox::Action::"contract.read", Renox::Action::"contract.write", Renox::Action::"report.view", Renox::Action::"reports.view", Renox::Action::"reports.export", Renox::Action::"settings.read", Renox::Action::"settings.write", Renox::Action::"settings.update", Renox::Action::"branch.write", Renox::Action::"service.write", Renox::Action::"user.manage", Renox::Action::"booking.manage", Renox::Action::"twofa.reset", Renox::Action::"realtime.subscribe", Renox::Action::"part.read", Renox::Action::"part.write", Renox::Action::"stock.read", Renox::Action::"stock.move", Renox::Action::"purchase.read", Renox::Action::"purchase.write"], resource);
