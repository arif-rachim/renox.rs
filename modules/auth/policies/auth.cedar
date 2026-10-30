// Default policies of the auth module (evaluated from F5, #279). A user
// reads and updates only their own account and revokes only their own
// sessions. `Auth::Account` and `Auth::Session` are the module's entity
// types ([authz.entities] in module.toml); the app names them `auth:Account`
// and `auth:Session`.
permit (principal is Renox::User, action == Renox::Action::"user.read", resource is Auth::Account)
  when { resource.id == principal.id };

permit (principal is Renox::User, action == Renox::Action::"user.update_self", resource is Auth::Account)
  when { resource.id == principal.id };

permit (principal is Renox::User, action == Renox::Action::"session.revoke", resource is Auth::Session)
  when { resource.user_id == principal.id };
