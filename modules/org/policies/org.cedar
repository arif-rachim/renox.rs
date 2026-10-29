// Default policies of the org module (files only in F4; evaluated from F5
// with `scope` = currentOrg's { org_id, role } in the authz context,
// docs/11-authorization.md). Until then the services check membership
// themselves (lib/core.ts).
permit (principal is User, action == Action::"org.read", resource is Org)
  when { context.scope.org_id == resource.id };

permit (principal is User, action == Action::"org.invite", resource is Org)
  when { context.scope.org_id == resource.id && ["owner", "admin"].contains(context.scope.role) };

permit (principal is User, action == Action::"org.manage_members", resource is Org)
  when { context.scope.org_id == resource.id && ["owner", "admin"].contains(context.scope.role) };
