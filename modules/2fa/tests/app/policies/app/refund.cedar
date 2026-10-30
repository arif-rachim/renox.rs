// A refund needs a recent second factor (docs/11-authorization.md:
// `forbid … unless context.mfa_verified`, here on the principal).
permit (principal is Renox::User, action == Renox::Action::"invoice.refund", resource == Renox::Action::"invoice.refund")
when { principal has mfa_verified && principal.mfa_verified };
