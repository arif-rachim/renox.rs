//! The fail-closed engine (`ops.md` 1.5.0 section 17, "`authz` ops",
//! "Decision"; `docs/24-threat-model.md` rule 3).

use std::collections::{BTreeSet, HashMap, HashSet};

use cedar_policy::{
    Authorizer, Context, Decision as CedarDecision, Entities, Entity, EntityUid, Request,
    RestrictedExpression,
};
use serde::Serialize;

use crate::entities::{Principal, to_cedar, uid};
use crate::{MergedSchema, PolicySet, REALTIME_SUBSCRIBE};

/// Why a decision came out the way it did; the `details.reason` of
/// `RENOX_FORBIDDEN` for a deny.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// A permit applied and no forbid did.
    Allow,
    /// No permit, or a forbid.
    Deny,
    /// The action is not in the merged action set.
    UnknownAction,
    /// The resource's type is not declared, or a declared attribute is missing.
    MissingAttribute,
    /// A policy failed to evaluate (a missing principal attribute, a type
    /// error); the messages, which name the policy, never a value.
    EvaluationError(Vec<String>),
}

impl Reason {
    /// The contract's spelling: `deny`, `unknown_action`, …
    pub fn as_str(&self) -> &'static str {
        match self {
            Reason::Allow => "allow",
            Reason::Deny => "deny",
            Reason::UnknownAction => "unknown_action",
            Reason::MissingAttribute => "missing_attribute",
            Reason::EvaluationError(_) => "evaluation_error",
        }
    }
}

/// The answer to one question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Decision {
    pub allow: bool,
    /// The deciding policies: the permits of an allow, the forbids of a deny
    /// by forbid; empty for a deny without a permit.
    pub policies: Vec<String>,
    pub reason: Reason,
}

impl Decision {
    fn deny(reason: Reason) -> Decision {
        Decision {
            allow: false,
            policies: Vec::new(),
            reason,
        }
    }
}

/// `explain`'s answer (`ops.md` section 17: `Explanation`), plus the text
/// of the deciding policies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Explanation {
    /// `allow` or `deny`.
    pub decision: &'static str,
    /// The permitting or forbidding policy ids.
    pub reasons: Vec<String>,
    /// Evaluation errors and the fail-closed reason, if any.
    pub errors: Vec<String>,
    /// `(policy id, file, text)` of every deciding policy.
    pub policies: Vec<(String, String, String)>,
}

impl Explanation {
    /// Human-readable, for `renox authz explain` and the dev overlay.
    pub fn text(&self) -> String {
        let mut out = format!("{}\n", self.decision.to_uppercase());
        if self.reasons.is_empty() && self.decision == "deny" && self.errors.is_empty() {
            out.push_str("no policy permits this request\n");
        }
        for (id, file, text) in &self.policies {
            out.push_str(&format!("\n{id} ({file}):\n{}\n", text.trim_end()));
        }
        for e in &self.errors {
            out.push_str(&format!("\nerror: {e}\n"));
        }
        out
    }
}

/// The keys the platform writes over the caller's `context` (`ops.md`
/// section 17): `mfa_verified` comes from the principal, `now` and
/// `request` from the cell. Tenant code cannot spoof them.
#[derive(Debug, Clone, Default)]
pub struct PlatformContext {
    /// Unix time in milliseconds.
    pub now_ms: i64,
    /// `(method, path)` of the request; `None` outside a request.
    pub request: Option<(String, String)>,
}

/// One deployment's policies and schema.
#[derive(Debug, Clone)]
pub struct Engine {
    schema: MergedSchema,
    policies: PolicySet,
    authorizer: std::sync::Arc<Authorizer>,
    /// `Renox::Action::"<sensitive action>"` in `Renox::Action::"sensitive"`:
    /// the action hierarchy Cedar needs at evaluation time for
    /// `action in Renox::Action::"sensitive"`.
    action_entities: Vec<Entity>,
}

impl Engine {
    pub fn new(schema: MergedSchema, policies: PolicySet) -> Engine {
        let group = uid("Renox::Action", "sensitive");
        let mut action_entities = vec![Entity::new_no_attrs(group.clone(), HashSet::new())];
        action_entities.extend(schema.sensitive.iter().map(|a| {
            Entity::new_no_attrs(uid("Renox::Action", a), HashSet::from([group.clone()]))
        }));
        Engine {
            schema,
            policies,
            authorizer: std::sync::Arc::new(Authorizer::new()),
            action_entities,
        }
    }

    pub fn schema(&self) -> &MergedSchema {
        &self.schema
    }

    pub fn policies(&self) -> &PolicySet {
        &self.policies
    }

    /// Whether `action` is in the `[authz] sensitive` list of its owner.
    pub fn is_sensitive(&self, action: &str) -> bool {
        self.schema.sensitive.contains(action)
    }

    /// `check(principal, action, resource, context)`: `resource` is a
    /// `ResourceRef` (`{ type, id, …attrs }`) asked through `module`'s `ctx`
    /// (`None`: the app), or `None` for a resource-less check, which is
    /// evaluated against `Renox::Action::"<action>"` itself.
    pub fn check(
        &self,
        principal: &Principal,
        action: &str,
        resource: Option<&serde_json::Value>,
        module: Option<&str>,
        context: Option<&serde_json::Map<String, serde_json::Value>>,
        platform: &PlatformContext,
    ) -> Decision {
        if !self.schema.actions.contains(action) || action == REALTIME_SUBSCRIBE {
            return Decision::deny(Reason::UnknownAction);
        }
        let (resource_uid, resource_entity) = match resource {
            None => (uid("Renox::Action", action), None),
            Some(r) => match self.resource(r, module) {
                Some((u, e)) => (u, Some(e)),
                None => return Decision::deny(Reason::MissingAttribute),
            },
        };
        self.evaluate(
            principal,
            action,
            resource_uid,
            resource_entity,
            context,
            platform,
        )
    }

    /// One decision per resource, in order (`op_authz_check_batch`).
    pub fn check_batch(
        &self,
        principal: &Principal,
        action: &str,
        resources: &[serde_json::Value],
        module: Option<&str>,
        context: Option<&serde_json::Map<String, serde_json::Value>>,
        platform: &PlatformContext,
    ) -> Vec<Decision> {
        resources
            .iter()
            .map(|r| self.check(principal, action, Some(r), module, context, platform))
            .collect()
    }

    /// `realtime.subscribe` on `Renox::Topic::"<topic>"` (`ops.md` section
    /// 18): `name` and `segments` as attributes; fail closed.
    pub fn check_topic(
        &self,
        principal: &Principal,
        topic: &str,
        platform: &PlatformContext,
    ) -> Decision {
        let u = uid("Renox::Topic", topic);
        let attrs: HashMap<String, RestrictedExpression> = HashMap::from([
            (
                "name".to_string(),
                RestrictedExpression::new_string(topic.to_string()),
            ),
            (
                "segments".to_string(),
                RestrictedExpression::new_set(
                    topic
                        .split(':')
                        .map(|s| RestrictedExpression::new_string(s.to_string())),
                ),
            ),
        ]);
        let Ok(entity) = Entity::new(u.clone(), attrs, HashSet::new()) else {
            return Decision::deny(Reason::MissingAttribute);
        };
        self.evaluate(
            principal,
            REALTIME_SUBSCRIBE,
            u,
            Some(entity),
            None,
            platform,
        )
    }

    /// The resource-less actions `principal` is allowed, computed once per
    /// request for `r-can` without a resource and fragment cache keys.
    pub fn action_set(
        &self,
        principal: &Principal,
        platform: &PlatformContext,
    ) -> BTreeSet<String> {
        self.schema
            .actions
            .iter()
            .filter(|a| a.as_str() != REALTIME_SUBSCRIBE)
            .filter(|a| self.check(principal, a, None, None, None, platform).allow)
            .cloned()
            .collect()
    }

    /// The deciding policies in text, and the errors (dev mode only; the
    /// caller enforces that).
    pub fn explain(
        &self,
        principal: &Principal,
        action: &str,
        resource: Option<&serde_json::Value>,
        module: Option<&str>,
        context: Option<&serde_json::Map<String, serde_json::Value>>,
        platform: &PlatformContext,
    ) -> Explanation {
        let d = self.check(principal, action, resource, module, context, platform);
        let mut errors = Vec::new();
        match &d.reason {
            Reason::EvaluationError(es) => errors.extend(es.iter().cloned()),
            Reason::UnknownAction => {
                errors.push(format!("{action:?} is not in the merged action set"))
            }
            Reason::MissingAttribute => errors.push(
                "the resource's type is not declared, or a declared attribute is missing".into(),
            ),
            _ => {}
        }
        let policies = d
            .policies
            .iter()
            .filter_map(|id| {
                self.policies
                    .source(id)
                    .map(|(f, t)| (id.clone(), f.to_string(), t.to_string()))
            })
            .collect();
        Explanation {
            decision: if d.allow { "allow" } else { "deny" },
            reasons: d.policies.clone(),
            errors,
            policies,
        }
    }

    /// The entity of a `ResourceRef`: only the declared attributes, every
    /// one of them present; `None` for an unknown type or a missing attribute.
    fn resource(&self, r: &serde_json::Value, module: Option<&str>) -> Option<(EntityUid, Entity)> {
        let obj = r.as_object()?;
        let ty = obj.get("type")?.as_str()?;
        let id = match obj.get("id")? {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) if n.is_i64() => n.to_string(),
            _ => return None,
        };
        let et = self.schema.resolve_type(module, ty)?;
        let mut attrs = HashMap::new();
        for a in &et.decl.attrs {
            let v = to_cedar(obj.get(a)?)?;
            attrs.insert(a.clone(), v);
        }
        let u = uid(&et.cedar, &id);
        let e = Entity::new(u.clone(), attrs, HashSet::new()).ok()?;
        Some((u, e))
    }

    fn evaluate(
        &self,
        principal: &Principal,
        action: &str,
        resource: EntityUid,
        resource_entity: Option<Entity>,
        context: Option<&serde_json::Map<String, serde_json::Value>>,
        platform: &PlatformContext,
    ) -> Decision {
        let mut pairs: HashMap<String, RestrictedExpression> = context
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| to_cedar(v).map(|e| (k.clone(), e)))
            .collect();
        pairs.insert(
            "mfa_verified".into(),
            RestrictedExpression::new_bool(principal.mfa_verified()),
        );
        pairs.insert(
            "now".into(),
            RestrictedExpression::new_long(platform.now_ms),
        );
        match &platform.request {
            Some((method, path)) => {
                let rec = RestrictedExpression::new_record([
                    (
                        "method".to_string(),
                        RestrictedExpression::new_string(method.clone()),
                    ),
                    (
                        "path".to_string(),
                        RestrictedExpression::new_string(path.clone()),
                    ),
                ]);
                match rec {
                    Ok(r) => {
                        pairs.insert("request".into(), r);
                    }
                    Err(e) => return Decision::deny(Reason::EvaluationError(vec![e.to_string()])),
                }
            }
            None => {
                pairs.remove("request");
            }
        }
        let ctx = match Context::from_pairs(pairs) {
            Ok(c) => c,
            Err(e) => return Decision::deny(Reason::EvaluationError(vec![e.to_string()])),
        };
        let action_uid = uid("Renox::Action", action);
        let req = match Request::new(principal.uid(), action_uid, resource, ctx, None) {
            Ok(r) => r,
            Err(e) => return Decision::deny(Reason::EvaluationError(vec![e.to_string()])),
        };
        let mut entities = principal.entities();
        entities.extend(resource_entity);
        entities.extend(self.action_entities.iter().cloned());
        let entities = match Entities::from_entities(entities, None) {
            Ok(e) => e,
            Err(e) => return Decision::deny(Reason::EvaluationError(vec![e.to_string()])),
        };
        let resp = self
            .authorizer
            .is_authorized(&req, &self.policies.set, &entities);
        let errors: Vec<String> = resp.diagnostics().errors().map(|e| e.to_string()).collect();
        let mut policies: Vec<String> =
            resp.diagnostics().reason().map(|p| p.to_string()).collect();
        policies.sort();
        // Fail closed: an error in any policy (a forbid that could not be
        // evaluated would otherwise be skipped) denies the request.
        if !errors.is_empty() {
            return Decision {
                allow: false,
                policies,
                reason: Reason::EvaluationError(errors),
            };
        }
        match resp.decision() {
            CedarDecision::Allow => Decision {
                allow: true,
                policies,
                reason: Reason::Allow,
            },
            CedarDecision::Deny => Decision {
                allow: false,
                policies,
                reason: Reason::Deny,
            },
        }
    }
}
