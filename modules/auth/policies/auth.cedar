// Default policies of the auth module (files only in F4; evaluated from F5).
// A user reads and updates only their own account and revokes only their
// own sessions.
permit (principal is User, action == Action::"user.read", resource is User)
  when { resource == principal };

permit (principal is User, action == Action::"user.update_self", resource is User)
  when { resource == principal };

permit (principal is User, action == Action::"session.revoke", resource is Session)
  when { resource.user == principal };
