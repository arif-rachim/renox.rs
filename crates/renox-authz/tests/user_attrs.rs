//! `principal.has_password` (`ops.md` 1.23.0) and the app's declared boolean
//! user attributes (`[authz] user_attrs`, `manifest.md` 1.8.0, MF19).

mod common;

use common::*;
use renox_authz::{AuthzBlock, Engine, MergedSchema, Owner, PolicySet, Principal};
use serde_json::json;

fn app_with(user_attrs: serde_json::Value) -> Owner {
    let authz: AuthzBlock = serde_json::from_value(json!({
        "actions": ["order.read", "order.edit"],
        "user_attrs": user_attrs,
    }))
    .unwrap();
    Owner::new("app", authz)
}

fn engine_for(owner: Owner, policies: &str) -> Engine {
    let schema = MergedSchema::build(&[owner], None).unwrap_or_else(|e| panic!("{e:#?}"));
    let set = PolicySet::load(&[("policies/app/p.cedar".into(), policies.into())], &schema)
        .unwrap_or_else(|e| panic!("{e:#?}"));
    Engine::new(schema, set)
}

fn check(e: &Engine, p: &Principal, action: &str) -> bool {
    e.check(p, action, None, None, None, &now()).allow
}

const HAS_PASSWORD: &str = r#"
permit (principal is Renox::User, action == Renox::Action::"order.read", resource)
when { principal.has_password };
"#;

#[test]
fn a_policy_reads_has_password_and_a_missing_value_is_false() {
    let e = engine_for(app_with(json!([])), HAS_PASSWORD);
    let with = Principal::user("u_1").with_attr("has_password", json!(true));
    assert!(check(&e, &with, "order.read"));
    let without = Principal::user("u_2").with_attr("has_password", json!(false));
    assert!(!check(&e, &without, "order.read"));
    // No value at all: false, not an evaluation error.
    let d = e.check(
        &Principal::user("u_3"),
        "order.read",
        None,
        None,
        None,
        &now(),
    );
    assert!(!d.allow);
    assert_eq!(d.reason, renox_authz::Reason::Deny, "{d:?}");
    // Not a boolean: false.
    let junk = Principal::user("u_4").with_attr("has_password", json!("yes"));
    assert!(!check(&e, &junk, "order.read"));
}

const PORTAL: &str = r#"
permit (principal is Renox::User, action in [Renox::Action::"order.read", Renox::Action::"order.edit"], resource);
forbid (principal is Renox::User, action == Renox::Action::"order.edit", resource)
when { principal.portal };
"#;

#[test]
fn a_forbid_on_a_declared_app_attr() {
    let e = engine_for(app_with(json!(["portal"])), PORTAL);
    let staff = Principal::user("u_staff");
    let customer = Principal::user("u_cust").with_attr("portal", json!(true));
    assert!(check(&e, &staff, "order.edit"), "staff may edit");
    assert!(!check(&e, &customer, "order.edit"), "portal is forbidden");
    assert!(check(&e, &customer, "order.read"));
    assert_eq!(e.schema().user_attrs, vec!["portal".to_string()]);
    // A non-boolean value counts as false.
    let junk = Principal::user("u_x").with_attr("portal", json!("true"));
    assert!(check(&e, &junk, "order.edit"));
}

#[test]
fn an_undeclared_attr_is_not_in_the_schema() {
    // The policy names `portal`, which the app did not declare.
    let schema = MergedSchema::build(&[app_with(json!([]))], None).unwrap();
    let errs =
        PolicySet::load(&[("policies/app/p.cedar".into(), PORTAL.into())], &schema).unwrap_err();
    assert!(
        errs.iter().any(|e| e.message.contains("portal")),
        "{errs:#?}"
    );
}

#[test]
fn bad_declarations_are_schema_errors() {
    let msg = |attrs: serde_json::Value| -> String {
        let errs = MergedSchema::build(&[app_with(attrs)], None).unwrap_err();
        errs.iter()
            .map(|e| e.message.clone())
            .collect::<Vec<_>>()
            .join("\n")
    };
    assert!(msg(json!(["has_password"])).contains("platform attribute"));
    assert!(msg(json!(["id"])).contains("platform attribute"));
    assert!(msg(json!(["Portal"])).contains("does not match"));
    assert!(msg(json!(["a"])).contains("does not match"));
    let nine: Vec<String> = (0..9).map(|i| format!("flag_{i}")).collect();
    assert!(msg(json!(nine)).contains("more than 8"));
    // A module cannot declare them.
    let module = Owner::new(
        "billing",
        serde_json::from_value::<AuthzBlock>(json!({ "user_attrs": ["portal"] })).unwrap(),
    );
    let errs = MergedSchema::build(&[module], None).unwrap_err();
    assert!(errs[0].message.contains("only be declared by the app"));
}
