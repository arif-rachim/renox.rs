//! Secrets (`docs/contracts/ops.md` section 3, `docs/04-isolation-security.md`
//! "Secrets"): selection of the declared secrets, the short-value rule, the
//! redaction of every string that leaves the isolate towards a log or an
//! error, and `op_secrets_get_all`.
//!
//! The pure part compiles without V8.

use std::borrow::Cow;
use std::collections::BTreeMap;

/// Secret values shorter than this are refused when secrets are loaded:
/// redacting very short strings would mangle every log line.
pub const MIN_SECRET_BYTES: usize = 8;

/// What replaces a secret value.
pub const REDACTED: &str = "[redacted]";

/// The secrets an isolate receives: only the names the manifest declares
/// (`permissions.secrets`) that the tenant has set. A declared but unset
/// secret is absent.
pub fn select(declared: &[String], set: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    declared
        .iter()
        .filter_map(|name| set.get(name).map(|v| (name.clone(), v.clone())))
        .collect()
}

/// Refuse values shorter than [`MIN_SECRET_BYTES`]; the error is the
/// secret's **name**, never its value.
pub fn check_lengths(secrets: &BTreeMap<String, String>) -> Result<(), String> {
    match secrets.iter().find(|(_, v)| v.len() < MIN_SECRET_BYTES) {
        Some((name, _)) => Err(name.clone()),
        None => Ok(()),
    }
}

/// Replaces every occurrence of a secret value with [`REDACTED`]. Exact
/// substrings of the UTF-8 value; encoded forms are not caught (ops.md
/// section 3, a documented limitation).
#[derive(Debug, Default, Clone)]
pub struct Redactor {
    /// Longest first, so a secret that contains another is replaced whole.
    values: Vec<String>,
}

impl Redactor {
    pub fn new<'a>(values: impl IntoIterator<Item = &'a String>) -> Redactor {
        let mut values: Vec<String> = values
            .into_iter()
            .filter(|v| v.len() >= MIN_SECRET_BYTES)
            .cloned()
            .collect();
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        values.dedup();
        Redactor { values }
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub fn redact<'a>(&self, s: &'a str) -> Cow<'a, str> {
        let mut out = Cow::Borrowed(s);
        for v in &self.values {
            if out.contains(v.as_str()) {
                out = Cow::Owned(out.replace(v.as_str(), REDACTED));
            }
        }
        out
    }

    /// Redact every string (keys too) of a JSON value in place.
    pub fn redact_json(&self, v: &mut serde_json::Value) {
        if self.values.is_empty() {
            return;
        }
        match v {
            serde_json::Value::String(s) => {
                if let Cow::Owned(r) = self.redact(s) {
                    *s = r;
                }
            }
            serde_json::Value::Array(a) => a.iter_mut().for_each(|v| self.redact_json(v)),
            serde_json::Value::Object(m) => self.redact_map(m),
            _ => {}
        }
    }

    pub fn redact_map(&self, m: &mut serde_json::Map<String, serde_json::Value>) {
        if self.values.is_empty() {
            return;
        }
        let entries = std::mem::take(m);
        for (k, mut v) in entries {
            self.redact_json(&mut v);
            m.insert(self.redact(&k).into_owned(), v);
        }
    }
}

#[cfg(feature = "v8")]
pub(crate) use v8_ops::*;

#[cfg(feature = "v8")]
mod v8_ops {
    use std::collections::BTreeMap;

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;

    use crate::ops::request::op_error;

    /// The isolate's secrets until the bootstrap takes them.
    /// Module (`app` for the app) → its secrets, until `op_secrets_get_all`
    /// takes them (ops.md 1.3.0 section 3: once per module).
    pub(crate) struct SecretsState(pub BTreeMap<String, Option<BTreeMap<String, String>>>);

    /// Called once per module by the bootstrap before any tenant module
    /// runs; a second call for the same module, or a call for a module that
    /// is not installed, rejects with `RENOX_SECRETS_CONSUMED`.
    #[op2]
    #[serde]
    pub(crate) fn op_secrets_get_all(
        state: &mut OpState,
        #[string] module: Option<String>,
    ) -> Result<BTreeMap<String, String>, JsErrorBox> {
        let key = module.unwrap_or_else(|| "app".into());
        state
            .borrow_mut::<SecretsState>()
            .0
            .get_mut(&key)
            .and_then(Option::take)
            .ok_or_else(|| {
                op_error(
                    "RENOX_SECRETS_CONSUMED",
                    serde_json::Value::Null,
                    "Secrets were already handed out for this isolate.",
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_declared_and_set_secrets_are_selected() {
        let set: BTreeMap<String, String> = [
            ("STRIPE_KEY".to_string(), "sk_live_123456".to_string()),
            ("OTHER".to_string(), "other-secret-value".to_string()),
        ]
        .into();
        let declared = vec!["STRIPE_KEY".to_string(), "UNSET".to_string()];
        let s = select(&declared, &set);
        assert_eq!(s.len(), 1);
        assert!(s.contains_key("STRIPE_KEY"));
    }

    #[test]
    fn short_values_are_refused_by_name() {
        let set: BTreeMap<String, String> = [("PIN".to_string(), "1234".to_string())].into();
        assert_eq!(check_lengths(&set), Err("PIN".to_string()));
    }

    #[test]
    fn every_occurrence_is_redacted_longest_first() {
        let a = "sk_live_123456".to_string();
        let b = "sk_live_123456_extended".to_string();
        let r = Redactor::new([&a, &b]);
        assert_eq!(
            r.redact("x sk_live_123456_extended y sk_live_123456"),
            "x [redacted] y [redacted]"
        );
        let mut v = serde_json::json!({ "k": ["sk_live_123456"], "sk_live_123456": 1 });
        r.redact_json(&mut v);
        assert_eq!(
            v,
            serde_json::json!({ "k": ["[redacted]"], "[redacted]": 1 })
        );
    }
}
