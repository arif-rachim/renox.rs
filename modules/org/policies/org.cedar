// Default policies of the org module (evaluated from F5, #279). A user
// reads the organisation of their session (`principal.org`, from
// `auth.principal`); org admins and owners invite and manage members. The
// roles are role assignments (`renox__role_assignments`), granted by the
// org services. The services still check membership themselves
// (lib/core.ts).
permit (principal is Renox::User, action == Renox::Action::"org.read", resource is Org::Org)
  when { resource.id == principal.org };

permit (
  principal in Renox::Role::"admin",
  action in [Renox::Action::"org.invite", Renox::Action::"org.manage_members"],
  resource is Org::Org
)
  when { resource.id == principal.org };

permit (
  principal in Renox::Role::"owner",
  action in [Renox::Action::"org.invite", Renox::Action::"org.manage_members"],
  resource is Org::Org
)
  when { resource.id == principal.org };
