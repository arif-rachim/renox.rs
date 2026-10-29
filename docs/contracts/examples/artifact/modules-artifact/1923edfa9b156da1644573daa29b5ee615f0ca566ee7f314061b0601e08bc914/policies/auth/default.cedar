// Default policies of the auth module (evaluated from F5).
permit (principal, action == Action::"user.read", resource) when { principal == resource };
