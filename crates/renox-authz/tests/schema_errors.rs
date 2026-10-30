//! Schema violations with line numbers (`RENOX_POLICY_INVALID`,
//! `artifact.md` V24): every error collected, with its file, line, and
//! column.

mod common;

use common::*;
use renox_authz::{AuthzBlock, MergedSchema, Owner, PolicySet};
use serde_json::json;

fn load(text: &str) -> Vec<renox_authz::PolicyError> {
    let schema = MergedSchema::build(&[billing(), app()], None).unwrap();
    PolicySet::load(&[("policies/app/p.cedar".into(), text.into())], &schema).unwrap_err()
}

#[test]
fn a_parse_error_has_its_line_and_column() {
    let errs =
        load("permit (principal, action, resource);\n\npermit (principal action, resource);\n");
    assert_eq!(errs.len(), 1, "{errs:#?}");
    assert_eq!((errs[0].line, errs[0].column), (3, 19), "{errs:#?}");
    assert_eq!(
        errs[0].to_string().split(": ").next(),
        Some("policies/app/p.cedar:3:19")
    );
}

#[test]
fn unknown_entity_type_attribute_and_type_errors() {
    let errs = load(concat!(
        "permit (principal, action == Renox::Action::\"invoice.read\", resource is Billing::Receipt);\n",
        "permit (principal, action == Renox::Action::\"invoice.read\", resource is Billing::Invoice) when { resource.colour == \"red\" };\n",
        "permit (principal, action == Renox::Action::\"invoice.read\", resource is Billing::Invoice) when { resource.amount == \"ten\" };\n",
    ));
    let lines: Vec<u32> = errs.iter().map(|e| e.line).collect();
    assert!(
        lines.contains(&1) && lines.contains(&2) && lines.contains(&3),
        "{errs:#?}"
    );
    assert!(
        errs.iter().any(|e| e.message.contains("Billing::Receipt")),
        "{errs:#?}"
    );
    assert!(
        errs.iter().any(|e| e.message.contains("colour")),
        "{errs:#?}"
    );
}

#[test]
fn errors_across_files_are_all_reported_and_templates_refused() {
    let schema = MergedSchema::build(&[billing(), app()], None).unwrap();
    let errs = PolicySet::load(
        &[
            ("policies/app/a.cedar".into(), "permit (principal == ?principal, action, resource);".into()),
            ("policies/billing/b.cedar".into(), "permit (principal, action == Renox::Action::\"nope\", resource);".into()),
            ("policies/billing/c.cedar".into(), "@id(\"x\") permit (principal, action, resource);\n@id(\"x\") forbid (principal, action, resource);".into()),
        ],
        &schema,
    )
    .unwrap_err();
    let files: Vec<&str> = errs.iter().map(|e| e.file.as_str()).collect();
    assert!(files.contains(&"policies/app/a.cedar"), "{errs:#?}");
    assert!(files.contains(&"policies/billing/c.cedar"), "{errs:#?}");
    assert!(
        errs.iter()
            .any(|e| e.message.contains("duplicate policy id")),
        "{errs:#?}"
    );
}

#[test]
fn schema_conflicts_are_errors() {
    let dup = Owner::new(
        "shop",
        serde_json::from_value::<AuthzBlock>(json!({ "actions": ["invoice.read"] })).unwrap(),
    );
    let errs = MergedSchema::build(&[billing(), dup], None).unwrap_err();
    assert!(
        errs.iter()
            .any(|e| e.message.contains("duplicate action \"invoice.read\"")),
        "{errs:#?}"
    );
    let platform = Owner::new(
        "shop",
        serde_json::from_value::<AuthzBlock>(json!({ "actions": ["realtime.subscribe"] })).unwrap(),
    );
    assert!(MergedSchema::build(&[platform], None).is_err());
    let bad_sensitive = Owner::new(
        "shop",
        serde_json::from_value::<AuthzBlock>(json!({ "actions": ["a.b"], "sensitive": ["a.c"] }))
            .unwrap(),
    );
    assert!(MergedSchema::build(&[bad_sensitive], None).is_err());
    let bad_role = Owner::new(
        "shop",
        serde_json::from_value::<AuthzBlock>(
            json!({ "actions": ["a.b"], "default_roles": { "r": ["a.zzz"] } }),
        )
        .unwrap(),
    );
    assert!(MergedSchema::build(&[bad_role], None).is_err());
    // The app's schema: a syntax error has its line; an action in it is refused.
    let errs = MergedSchema::build(
        &[app()],
        Some("namespace App {\n  entity Thing = { x: Long\n}\n"),
    )
    .unwrap_err();
    assert_eq!(errs[0].file, "policies/schema.cedarschema");
    assert!(errs[0].line >= 2, "{errs:#?}");
    let errs =
        MergedSchema::build(&[app()], Some("namespace Renox { action \"x.y\"; }")).unwrap_err();
    assert!(errs.iter().any(|e| e.message.contains("x.y")), "{errs:#?}");
    // Declaring a platform type again is a duplicate.
    assert!(MergedSchema::build(&[app()], Some("namespace Renox { entity User; }")).is_err());
}

#[test]
fn the_app_schema_declares_its_own_entity() {
    let app = Owner::new(
        "app",
        serde_json::from_value::<AuthzBlock>(
            json!({ "actions": ["order.read"], "entities": { "Order": { "attrs": ["amount"] } } }),
        )
        .unwrap(),
    );
    let schema = MergedSchema::build(
        &[app],
        Some("namespace App { entity Order = { amount: Long }; }"),
    )
    .unwrap();
    let set = PolicySet::load(
        &[("policies/app/p.cedar".into(), "permit (principal, action == Renox::Action::\"order.read\", resource is App::Order) when { resource.amount < 5 };".into())],
        &schema,
    )
    .unwrap();
    assert_eq!(set.len(), 1);
    assert!(set.source("policies/app/p.cedar#0").is_some());
}
