// Default policies of the jobs module (#297; ops.md 1.6.0 section 20): an
// admin reads and manages the app's jobs, an operator only reads them. The
// app grants the roles; the module never grants them itself. jobs.manage is
// sensitive, so every retry or cancel decision leaves a row of
// renox__authz_audit besides the op's own row.
permit (
  principal in Renox::Role::"admin",
  action in [Renox::Action::"jobs.read", Renox::Action::"jobs.manage"],
  resource
);

permit (
  principal in Renox::Role::"operator",
  action == Renox::Action::"jobs.read",
  resource
);
