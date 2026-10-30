// Default policy of the audit module (#288): reading the trail is for
// auditors (a role assignment the app grants; the module never grants it
// itself). `audit.read` is sensitive, so every read, allowed or not, is
// itself a row of renox__authz_audit.
permit (
  principal in Renox::Role::"auditor",
  action == Renox::Action::"audit.read",
  resource == Renox::Action::"audit.read"
);
