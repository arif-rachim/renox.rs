//! The `billing` module of `docs/11-authorization.md` and an app, as the
//! cell would hand them to the engine.
#![allow(dead_code)]

use renox_authz::{
    AttrType, AuthzBlock, Engine, MergedSchema, Owner, PlatformContext, PolicySet, Principal,
};
use serde_json::json;

pub fn billing() -> Owner {
    let authz: AuthzBlock = serde_json::from_value(json!({
        "actions": ["invoice.read", "invoice.create", "invoice.refund"],
        "sensitive": ["invoice.refund"],
        "entities": { "Invoice": { "table": "billing__invoices", "attrs": ["amount", "org", "status"] } },
        "default_roles": { "finance": ["invoice.read", "invoice.refund"], "viewer": ["invoice.read"] }
    }))
    .unwrap();
    Owner::new("billing", authz).with_type("Invoice", "amount", AttrType::Long)
}

pub fn app() -> Owner {
    let authz: AuthzBlock = serde_json::from_value(json!({
        "actions": ["report.read", "order.read"],
        "entities": { "Order": { "table": "app__orders", "attrs": ["user_id", "total"] } }
    }))
    .unwrap();
    Owner::new("app", authz).with_type("Order", "total", AttrType::Long)
}

/// `docs/11`'s three policies, in Cedar as the merged schema qualifies them.
pub const BILLING_POLICIES: &str = r#"
@id("billing.finance")
permit (principal in Renox::Role::"finance",
        action in [Renox::Action::"invoice.read", Renox::Action::"invoice.refund"],
        resource is Billing::Invoice)
when { resource.org == principal.org };

@id("billing.refund_limit")
forbid (principal, action == Renox::Action::"invoice.refund", resource)
when { resource has amount && resource.amount > 10000000 } unless { principal in Renox::Role::"finance_manager" };

@id("billing.sensitive_mfa")
forbid (principal, action in Renox::Action::"sensitive", resource)
unless { context.mfa_verified };
"#;

pub const APP_POLICIES: &str = r#"
permit (principal in Renox::Role::"admin", action == Renox::Action::"report.read", resource);

permit (principal is Renox::User, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "user:*:inbox" && resource.segments.contains(principal.id) };

permit (principal, action == Renox::Action::"realtime.subscribe", resource is Renox::Topic)
when { resource.name like "public:*" };
"#;

pub fn files() -> Vec<(String, String)> {
    vec![
        (
            "policies/billing/default.cedar".into(),
            BILLING_POLICIES.into(),
        ),
        ("policies/app/default.cedar".into(), APP_POLICIES.into()),
    ]
}

pub fn engine_with(files: &[(String, String)]) -> Engine {
    let schema =
        MergedSchema::build(&[billing(), app()], None).unwrap_or_else(|e| panic!("{e:#?}"));
    let set = PolicySet::load(files, &schema).unwrap_or_else(|e| panic!("{e:#?}"));
    Engine::new(schema, set)
}

pub fn engine() -> Engine {
    engine_with(&files())
}

pub fn now() -> PlatformContext {
    PlatformContext {
        now_ms: 1_700_000_000_000,
        request: Some(("POST".into(), "/billing/invoices/inv_1".into())),
    }
}

/// Alice: `finance` in organisation `o_1`, MFA verified.
pub fn alice() -> Principal {
    Principal::user("u_alice")
        .with_role("finance", "org", Some("o_1"))
        .with_attr("org", json!("o_1"))
        .with_attr("mfa_verified", json!(true))
}

pub fn invoice(id: &str, amount: i64, org: &str) -> serde_json::Value {
    json!({ "type": "Invoice", "id": id, "amount": amount, "org": org, "status": "paid", "customer_email": "x@example.com" })
}
