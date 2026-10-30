//! `renox-authz`: the policy engine of a deployment (`docs/11-authorization.md`,
//! ADR D15; `docs/contracts/ops.md` 1.5.0 section 17; #276).
//!
//! - [`MergedSchema::build`]: the platform schema, one namespace per owner
//!   generated from its `authz` block, and the app's
//!   `policies/schema.cedarschema`.
//! - [`PolicySet::load`]: every policy file parsed and validated (strict)
//!   against the merged schema; every error as a [`PolicyError`] with file,
//!   line, and column (the body of `RENOX_POLICY_INVALID`).
//! - [`Engine`]: `check`, `check_batch`, `check_topic`, `action_set`,
//!   `explain` for a [`Principal`] given as a value. Fail closed: `forbid`
//!   wins, and no permit, an unknown action, a missing attribute, or any
//!   evaluation error is a deny with its [`Reason`].
//! - [`DecisionCache`]: decisions by principal, action, resource, and
//!   context, with a TTL from the caller and invalidation per principal.
//!
//! A leaf crate: it reads no database and no artifact; the cell supplies
//! the policy files, the principal, and the resource values.

mod cache;
mod engine;
mod entities;
mod policy;
mod schema;

pub use cache::{CacheKey, CacheStats, DecisionCache};
pub use engine::{Decision, Engine, Explanation, PlatformContext, Reason};
pub use entities::{Principal, PrincipalKind, RoleAssignment};
pub use policy::PolicySet;
pub use schema::{
    APP_SCHEMA, AttrType, AuthzBlock, EntityDecl, EntityType, GENERATED, MergedSchema, Owner,
    REALTIME_SUBSCRIBE, USER_ATTRS, namespace_of,
};

/// One error of a policy file or of the schema: what `RENOX_POLICY_INVALID`
/// reports (`errors.md` 0.4, "Deploy"). `line` and `column` are 1-based;
/// 0 when the error has no location (a duplicate across files).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PolicyError {
    pub file: String,
    pub line: u32,
    pub column: u32,
    pub message: String,
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.line > 0 {
            write!(
                f,
                "{}:{}:{}: {}",
                self.file, self.line, self.column, self.message
            )
        } else {
            write!(f, "{}: {}", self.file, self.message)
        }
    }
}

impl PolicyError {
    /// The first labelled location of `d` in `text`, as line and column.
    pub(crate) fn from_diagnostic(
        file: &str,
        text: &str,
        d: &(dyn miette::Diagnostic + 'static),
    ) -> PolicyError {
        let offset = d.labels().and_then(|mut l| l.next()).map(|l| l.offset());
        let (line, column) = offset.map(|o| line_col(text, o)).unwrap_or((0, 0));
        PolicyError {
            file: file.to_string(),
            line,
            column,
            message: schema::diagnostic_text(d),
        }
    }
}

/// 1-based line and column (in characters) of byte `offset` in `text`.
pub(crate) fn line_col(text: &str, offset: usize) -> (u32, u32) {
    let offset = offset.min(text.len());
    let before = &text[..text.floor_char_boundary(offset)];
    let line = before.matches('\n').count() as u32 + 1;
    let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) as u32 + 1;
    (line, col)
}
