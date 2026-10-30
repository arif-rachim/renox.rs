//! Loading the policy files of a deployment: `policies/app/*.cedar` and
//! `policies/<module>/*.cedar` (`artifact.md` 1.3, V24).

use std::collections::BTreeMap;
use std::str::FromStr;

use cedar_policy::{PolicyId, ValidationMode, Validator};

use crate::{MergedSchema, PolicyError, line_col};

/// The validated policies of a deployment.
#[derive(Debug, Clone)]
pub struct PolicySet {
    pub(crate) set: cedar_policy::PolicySet,
    /// Policy id → (file, source text of the policy).
    pub(crate) sources: BTreeMap<String, (String, String)>,
}

impl PolicySet {
    /// Parses every file (`(path, text)`), names each policy `@id("…")`
    /// when it has one, else `<path>#<n>` (its 0-based position in the
    /// file), and validates the whole set against `schema` in strict mode.
    /// An unknown action or entity type, an attribute the schema does not
    /// declare, or a type error is an error, never a warning. Templates
    /// (`?principal`, `?resource`) are refused: the platform links none.
    pub fn load(
        files: &[(String, String)],
        schema: &MergedSchema,
    ) -> Result<PolicySet, Vec<PolicyError>> {
        let mut errors = Vec::new();
        let mut set = cedar_policy::PolicySet::new();
        let mut sources = BTreeMap::new();
        let mut offsets: BTreeMap<String, (String, usize)> = BTreeMap::new();
        let texts: BTreeMap<&str, &str> = files
            .iter()
            .map(|(p, t)| (p.as_str(), t.as_str()))
            .collect();
        let mut files: Vec<&(String, String)> = files.iter().collect();
        files.sort_by(|a, b| a.0.cmp(&b.0));
        for (path, text) in files {
            let parsed = match cedar_policy::PolicySet::from_str(text) {
                Ok(p) => p,
                Err(e) => {
                    errors.push(PolicyError::from_diagnostic(path, text, &e));
                    continue;
                }
            };
            if parsed.templates().next().is_some() {
                let at = text.find("?principal").or_else(|| text.find("?resource"));
                let (line, column) = at.map(|o| line_col(text, o)).unwrap_or((0, 0));
                errors.push(PolicyError {
                    file: path.clone(),
                    line,
                    column,
                    message: "a policy template (?principal or ?resource) is not supported; write the entity or leave the variable unconstrained".into(),
                });
                continue;
            }
            // Cedar names them policy0, policy1, … in file order.
            let mut ps: Vec<&cedar_policy::Policy> = parsed.policies().collect();
            ps.sort_by_key(|p| {
                p.id()
                    .to_string()
                    .trim_start_matches("policy")
                    .parse::<usize>()
                    .unwrap_or(usize::MAX)
            });
            for (n, p) in ps.into_iter().enumerate() {
                let id = p
                    .annotation("id")
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{path}#{n}"));
                // Where the policy starts, for errors without a label of their own.
                let offset = p
                    .annotation("id")
                    .and_then(|i| text.find(&format!("\"{i}\"")))
                    .unwrap_or(0);
                if offsets.contains_key(&id) {
                    let (line, column) = line_col(text, offset);
                    errors.push(PolicyError {
                        file: path.clone(),
                        line,
                        column,
                        message: format!("duplicate policy id {id:?}"),
                    });
                    continue;
                }
                let renamed = p.new_id(PolicyId::new(&id));
                sources.insert(id.clone(), (path.clone(), renamed.to_string()));
                offsets.insert(id.clone(), (path.clone(), offset));
                if let Err(e) = set.add(renamed) {
                    errors.push(PolicyError {
                        file: path.clone(),
                        line: 0,
                        column: 0,
                        message: e.to_string(),
                    });
                }
            }
        }
        if errors.is_empty() {
            let validator = Validator::new(schema.schema.clone());
            let result = validator.validate(&set, ValidationMode::Strict);
            for e in result.validation_errors() {
                let id = e.policy_id().to_string();
                let (file, base) = offsets.get(&id).cloned().unwrap_or_default();
                let at = miette::Diagnostic::labels(e)
                    .and_then(|mut l| l.next())
                    .map(|l| l.offset());
                // A label offset is relative to the file the policy came from.
                let (line, column) = line_col(
                    texts.get(file.as_str()).copied().unwrap_or_default(),
                    at.unwrap_or(base),
                );
                errors.push(PolicyError {
                    file,
                    line,
                    column,
                    message: crate::schema::diagnostic_text(e),
                });
            }
        }
        if errors.is_empty() {
            Ok(PolicySet { set, sources })
        } else {
            errors.sort_by(|a, b| (&a.file, a.line, a.column).cmp(&(&b.file, b.line, b.column)));
            errors.dedup();
            Err(errors)
        }
    }

    /// The number of policies.
    pub fn len(&self) -> usize {
        self.sources.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }

    /// The text of policy `id` and the file it came from.
    pub fn source(&self, id: &str) -> Option<(&str, &str)> {
        self.sources.get(id).map(|(f, t)| (f.as_str(), t.as_str()))
    }
}
