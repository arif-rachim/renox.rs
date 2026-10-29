//! The refund scenario of `docs/11-authorization.md` (role, amount
//! threshold, `mfa_verified`), scoped roles, topic subscriptions
//! (`ops.md` section 18: `user:B:inbox` denied to A), `action_set`,
//! `check_batch`, and `explain`.

mod common;

use common::*;
use renox_authz::{Principal, Reason};
use serde_json::json;

#[test]
fn refund_scenario() {
    let e = engine();
    let small = invoice("inv_1", 5_000, "o_1");
    // Finance in the org, MFA verified: allowed.
    let d = e.check(
        &alice(),
        "invoice.refund",
        Some(&small),
        Some("billing"),
        None,
        &now(),
    );
    assert!(d.allow, "{d:?}");
    assert_eq!(d.policies, vec!["billing.finance".to_string()]);
    assert!(e.is_sensitive("invoice.refund"));
    assert!(!e.is_sensitive("invoice.read"));
    // Another organisation's invoice: no permit.
    let d = e.check(
        &alice(),
        "invoice.refund",
        Some(&invoice("inv_2", 5_000, "o_2")),
        Some("billing"),
        None,
        &now(),
    );
    assert_eq!((d.allow, d.reason), (false, Reason::Deny));
    // Over 10,000,000: only finance_manager.
    let big = invoice("inv_3", 10_000_001, "o_1");
    assert!(
        !e.check(
            &alice(),
            "invoice.refund",
            Some(&big),
            Some("billing"),
            None,
            &now()
        )
        .allow
    );
    let manager = alice().with_role("finance_manager", "global", None);
    assert!(
        e.check(
            &manager,
            "invoice.refund",
            Some(&big),
            Some("billing"),
            None,
            &now()
        )
        .allow
    );
    // Without MFA: the sensitive group's forbid.
    let no_mfa = alice().with_attr("mfa_verified", json!(false));
    assert!(
        !e.check(
            &no_mfa,
            "invoice.refund",
            Some(&small),
            Some("billing"),
            None,
            &now()
        )
        .allow
    );
    // Reading is not sensitive: allowed without MFA.
    assert!(
        e.check(
            &no_mfa,
            "invoice.read",
            Some(&small),
            Some("billing"),
            None,
            &now()
        )
        .allow
    );
    // A viewer may not refund.
    let viewer = Principal::user("u_v")
        .with_role("viewer", "global", None)
        .with_attr("org", json!("o_1"))
        .with_attr("mfa_verified", json!(true));
    assert!(
        !e.check(
            &viewer,
            "invoice.refund",
            Some(&small),
            Some("billing"),
            None,
            &now()
        )
        .allow
    );
}

/// A scoped assignment is in effect only while the principal's attribute
/// equals its scope id: finance in `o_1` is not finance in `o_2`.
#[test]
fn scoped_roles_apply_only_in_their_scope() {
    let e = engine();
    let p = Principal::user("u_d")
        .with_role("finance", "org", Some("o_1"))
        .with_attr("org", json!("o_2"))
        .with_attr("mfa_verified", json!(true));
    assert_eq!(p.roles_in_effect(), Vec::<&str>::new());
    assert!(
        !e.check(
            &p,
            "invoice.read",
            Some(&invoice("inv_9", 1, "o_2")),
            Some("billing"),
            None,
            &now()
        )
        .allow
    );
    let admin = Principal::user("u_admin").with_role("admin", "global", None);
    assert_eq!(admin.roles_in_effect(), vec!["admin"]);
    assert!(
        e.check(&admin, "report.read", None, None, None, &now())
            .allow
    );
}

#[test]
fn topic_subscriptions() {
    let e = engine();
    let a = Principal::user("A");
    assert!(e.check_topic(&a, "user:A:inbox", &now()).allow);
    let d = e.check_topic(&a, "user:B:inbox", &now());
    assert_eq!((d.allow, d.reason), (false, Reason::Deny));
    assert!(e.check_topic(&a, "public:news", &now()).allow);
    assert!(
        e.check_topic(&Principal::anonymous(), "public:news", &now())
            .allow
    );
    assert!(
        !e.check_topic(&Principal::anonymous(), "user:A:inbox", &now())
            .allow
    );
    assert!(!e.check_topic(&a, "room:1", &now()).allow);
}

#[test]
fn action_set_batch_and_explain() {
    let e = engine();
    let admin = Principal::user("u_admin").with_role("admin", "global", None);
    assert_eq!(
        e.action_set(&admin, &now()).into_iter().collect::<Vec<_>>(),
        vec!["report.read".to_string()]
    );
    // invoice actions need a resource: none in the resource-less set.
    assert!(e.action_set(&alice(), &now()).is_empty());
    let invs = [
        invoice("a", 1, "o_1"),
        invoice("b", 1, "o_2"),
        invoice("c", 20_000_000, "o_1"),
    ];
    let ds = e.check_batch(
        &alice(),
        "invoice.refund",
        &invs,
        Some("billing"),
        None,
        &now(),
    );
    assert_eq!(
        ds.iter().map(|d| d.allow).collect::<Vec<_>>(),
        vec![true, false, false]
    );
    let x = e.explain(
        &alice(),
        "invoice.refund",
        Some(&invs[2]),
        Some("billing"),
        None,
        &now(),
    );
    assert_eq!(x.decision, "deny");
    assert_eq!(x.reasons, vec!["billing.refund_limit".to_string()]);
    let text = x.text();
    assert!(text.starts_with("DENY\n"), "{text}");
    assert!(
        text.contains("billing.refund_limit (policies/billing/default.cedar)"),
        "{text}"
    );
    assert!(text.contains("resource.amount > 10000000"), "{text}");
    let x = e.explain(
        &alice(),
        "invoice.read",
        Some(&invs[1]),
        Some("billing"),
        None,
        &now(),
    );
    assert!(
        x.text().contains("no policy permits this request"),
        "{}",
        x.text()
    );
    let x = e.explain(&alice(), "nope.nope", None, None, None, &now());
    assert_eq!(x.errors.len(), 1);
}

/// The f5 example artifact's policies and schema load as they are
/// (`docs/contracts/examples/artifact/f5-artifact`).
#[test]
fn the_contract_example_loads() {
    use renox_authz::{AuthzBlock, MergedSchema, Owner, PolicySet};
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/contracts/examples/artifact/f5-artifact/15d5eb4b46e038e5747a0abe69417266602257787239e513ff599d3f243be8af");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    let authz: AuthzBlock = serde_json::from_value(manifest["authz"].clone()).unwrap();
    let schema_text = std::fs::read_to_string(dir.join("policies/schema.cedarschema")).unwrap();
    let schema = MergedSchema::build(&[Owner::new("app", authz)], Some(&schema_text))
        .unwrap_or_else(|e| panic!("{e:#?}"));
    let files = vec![(
        "policies/app/default.cedar".to_string(),
        std::fs::read_to_string(dir.join("policies/app/default.cedar")).unwrap(),
    )];
    let errs = PolicySet::load(&files, &schema).unwrap_err();
    // The example reads `principal.org` without a type guard on an action
    // whose principals include Anonymous and System: strict validation
    // refuses it with the line of the attribute access.
    assert!(
        errs.iter()
            .all(|e| e.file == "policies/app/default.cedar" && e.line > 0),
        "{errs:#?}"
    );
}
