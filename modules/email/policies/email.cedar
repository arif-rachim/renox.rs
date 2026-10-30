// Default policies of the email module (#328): an admin reads the message
// log (recipients, subjects, templates and states; never the bodies) and
// lifts a suppression. The app grants the role; the module never grants it.
// email.manage is sensitive, so each decision is a row of renox__authz_audit.
permit (
  principal in Renox::Role::"admin",
  action in [Renox::Action::"email.read_log", Renox::Action::"email.manage"],
  resource
);
