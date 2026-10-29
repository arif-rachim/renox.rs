//! Fail closed (`ops.md` 1.5.0 section 17, "Decision";
//! `docs/24-threat-model.md` rule 3): no policy, an unknown action, a
//! missing attribute, and an evaluation error all deny; `forbid` wins over
//! `permit`.

mod common;

use common::*;
use renox_authz::{MergedSchema, PolicySet, Principal, Reason};
use serde_json::json;

/// An app with actions and no policy at all denies everything.
#[test]
fn no_policy_denies() {
    let e = engine_with(&[]);
    let d = e.check(
        &alice(),
        "invoice.read",
        Some(&invoice("inv_1", 10, "o_1")),
        Some("billing"),
        None,
        &now(),
    );
    assert!(!d.allow);
    assert_eq!(d.reason, Reason::Deny);
    assert!(d.policies.is_empty());
    assert!(e.action_set(&alice(), &now()).is_empty());
    // realtime.subscribe too: no permitting policy, no subscription.
    assert!(!e.check_topic(&alice(), "user:u_alice:inbox", &now()).allow);
}

/// A policy naming an action no owner declares is a load error, not a
/// warning; asking about an undeclared action at run time is a deny.
#[test]
fn unknown_action_is_a_load_error_and_a_deny() {
    let schema = MergedSchema::build(&[billing(), app()], None).unwrap();
    let errs = PolicySet::load(
        &[(
            "policies/app/x.cedar".into(),
            "permit (principal, action == Renox::Action::\"invoice.void\", resource);".into(),
        )],
        &schema,
    )
    .unwrap_err();
    assert_eq!(errs.len(), 1, "{errs:#?}");
    assert_eq!(errs[0].file, "policies/app/x.cedar");
    assert!(errs[0].message.contains("invoice.void"), "{errs:#?}");
    assert_eq!(
        (errs[0].line, errs[0].column),
        (1, 30),
        "the column of `Renox::Action`"
    );
    let d = engine().check(
        &alice(),
        "invoice.void",
        None,
        Some("billing"),
        None,
        &now(),
    );
    assert_eq!((d.allow, d.reason), (false, Reason::UnknownAction));
    // realtime.subscribe is a topic action only.
    let d = engine().check(&alice(), "realtime.subscribe", None, None, None, &now());
    assert_eq!(d.reason, Reason::UnknownAction);
}

/// A resource without one of its declared attributes, a resource of an
/// undeclared type, and a resource without an id are denied before Cedar
/// runs; attributes the caller adds are dropped, not an error.
#[test]
fn missing_attribute_denies() {
    let e = engine();
    let mut inv = invoice("inv_1", 10, "o_1");
    assert!(
        e.check(
            &alice(),
            "invoice.read",
            Some(&inv),
            Some("billing"),
            None,
            &now()
        )
        .allow
    );
    inv.as_object_mut().unwrap().remove("org");
    let d = e.check(
        &alice(),
        "invoice.read",
        Some(&inv),
        Some("billing"),
        None,
        &now(),
    );
    assert_eq!((d.allow, d.reason), (false, Reason::MissingAttribute));
    let mut nulled = invoice("inv_1", 10, "o_1");
    nulled["org"] = serde_json::Value::Null;
    assert_eq!(
        e.check(
            &alice(),
            "invoice.read",
            Some(&nulled),
            Some("billing"),
            None,
            &now()
        )
        .reason,
        Reason::MissingAttribute
    );
    let other = json!({ "type": "Receipt", "id": "r_1" });
    assert_eq!(
        e.check(
            &alice(),
            "invoice.read",
            Some(&other),
            Some("billing"),
            None,
            &now()
        )
        .reason,
        Reason::MissingAttribute
    );
    let no_id = json!({ "type": "Invoice", "amount": 1, "org": "o_1", "status": "paid" });
    assert_eq!(
        e.check(
            &alice(),
            "invoice.read",
            Some(&no_id),
            Some("billing"),
            None,
            &now()
        )
        .reason,
        Reason::MissingAttribute
    );
    // A module's type is its own: the app names it `billing:Invoice`.
    assert!(
        e.check(
            &alice(),
            "invoice.read",
            Some(&invoice("inv_1", 10, "o_1")),
            Some("org"),
            None,
            &now()
        )
        .reason
            == Reason::MissingAttribute
    );
    let mut named = invoice("inv_1", 10, "o_1");
    named["type"] = json!("billing:Invoice");
    assert!(
        e.check(&alice(), "invoice.read", Some(&named), None, None, &now())
            .allow
    );
}

/// `forbid` over `permit`: alice is `finance` (permit) but the refund is
/// over the limit (forbid); the deciding policy is the forbid.
#[test]
fn forbid_wins_over_permit() {
    let d = engine().check(
        &alice(),
        "invoice.refund",
        Some(&invoice("inv_big", 20_000_000, "o_1")),
        Some("billing"),
        None,
        &now(),
    );
    assert!(!d.allow);
    assert_eq!(d.reason, Reason::Deny);
    assert_eq!(d.policies, vec!["billing.refund_limit".to_string()]);
}

/// A policy that cannot be evaluated (the principal lacks `org`, which the
/// finance permit reads) denies with `evaluation_error`, and so does a
/// forbid that errors even when a permit applies: Cedar alone would skip
/// the erroring forbid and allow.
#[test]
fn evaluation_error_denies_with_reason() {
    let e = engine();
    let no_org = Principal::user("u_bob")
        .with_role("finance", "global", None)
        .with_attr("mfa_verified", json!(true));
    let d = e.check(
        &no_org,
        "invoice.read",
        Some(&invoice("inv_1", 10, "o_1")),
        Some("billing"),
        None,
        &now(),
    );
    assert!(!d.allow);
    match &d.reason {
        Reason::EvaluationError(es) => {
            assert!(es.iter().any(|m| m.contains("billing.finance")), "{es:?}")
        }
        r => panic!("{r:?}"),
    }
    assert_eq!(d.reason.as_str(), "evaluation_error");

    let files = vec![(
        "policies/app/err.cedar".to_string(),
        r#"permit (principal, action == Renox::Action::"report.read", resource);
           forbid (principal is Renox::User, action == Renox::Action::"report.read", resource) when { principal.created_at > 5 };"#
            .to_string(),
    )];
    let e = engine_with(&files);
    // u_carol has no created_at: the forbid errors; the permit applies.
    let carol = Principal::user("u_carol");
    let d = e.check(&carol, "report.read", None, None, None, &now());
    assert!(!d.allow, "{d:?}");
    assert!(matches!(d.reason, Reason::EvaluationError(_)));
    // With the attribute, the forbid evaluates (false) and the permit allows.
    let d = e.check(
        &carol.with_attr("created_at", json!(1)),
        "report.read",
        None,
        None,
        None,
        &now(),
    );
    assert!(d.allow, "{d:?}");
}

/// The anonymous principal has no roles and no attributes; `mfa_verified`
/// absent is `false`, and a caller cannot set it through `context`.
#[test]
fn anonymous_and_spoofed_context_deny() {
    let e = engine();
    assert!(
        !e.check(
            &Principal::anonymous(),
            "report.read",
            None,
            None,
            None,
            &now()
        )
        .allow
    );
    let no_mfa = alice().with_attr("mfa_verified", json!(false));
    let spoof = json!({ "mfa_verified": true }).as_object().unwrap().clone();
    let d = e.check(
        &no_mfa,
        "invoice.refund",
        Some(&invoice("inv_1", 10, "o_1")),
        Some("billing"),
        Some(&spoof),
        &now(),
    );
    assert!(!d.allow);
    assert_eq!(d.policies, vec!["billing.sensitive_mfa".to_string()]);
    let mut absent = alice();
    absent.attrs.remove("mfa_verified");
    assert!(
        !e.check(
            &absent,
            "invoice.refund",
            Some(&invoice("inv_1", 10, "o_1")),
            Some("billing"),
            None,
            &now()
        )
        .allow
    );
}
