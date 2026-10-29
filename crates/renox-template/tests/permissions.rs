//! `r-can` (#280, `docs/11-authorization.md`, "In templates"): the action
//! set lookup without a resource, one cached evaluation per resource charged
//! as render fuel, denied subtrees not rendered, the fragment cache key, and
//! the action list the worker's prepare checks. No V8.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use common::{compile_files, compile_fixture};
use minijinja::Value;
use renox_template::{
    CAN_FUEL, Can, CheckFn, RenderContext, RenderError, RenderLimits, RenderTarget, Renderer,
};
use serde_json::json;

fn value(v: serde_json::Value) -> Value {
    serde_json::from_value(v).unwrap()
}

fn cx(can: Can) -> RenderContext {
    RenderContext {
        can: Some(Arc::new(can)),
        ..RenderContext::default()
    }
}

/// A check that allows `cart.add` on products in stock and counts its calls.
fn counting_check(calls: Arc<AtomicUsize>) -> Arc<CheckFn> {
    Arc::new(move |action: &str, r: &serde_json::Value| {
        calls.fetch_add(1, Ordering::SeqCst);
        action == "cart.add" && r.get("stock").and_then(|s| s.as_i64()).unwrap_or(0) > 0
    })
}

fn render(
    r: &Renderer,
    page: &str,
    data: serde_json::Value,
    can: Can,
) -> renox_template::RenderOutput {
    r.render(
        RenderTarget::Page(page),
        value(data),
        &cx(can),
        &RenderLimits::DEFAULT,
    )
    .unwrap()
}

/// Without a resource `r-can` is a lookup in the action set: the check is
/// never called and no evaluation is counted.
#[test]
fn without_a_resource_is_a_set_lookup() {
    let c = compile_fixture("permission").unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let check = counting_check(calls.clone());
    let out = render(
        &r,
        "pages/index",
        json!({"products": []}),
        Can::actions(["admin.access"]).with_check(check.clone()),
    );
    assert!(
        out.html.contains(r#"<a href="/admin">Admin</a>"#),
        "{}",
        out.html
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(out.authz_evals, 0);
    let out = render(
        &r,
        "pages/index",
        json!({"products": []}),
        Can::actions(["cart.add"]).with_check(check),
    );
    assert!(!out.html.contains("/admin"), "not in the set: {}", out.html);
}

/// With a resource: one evaluation per distinct `(action, resource id)`;
/// `r-can` and `r-cannot` on the same item share it, and a repeated item is
/// a cache hit. Denied subtrees are absent.
#[test]
fn with_a_resource_one_cached_evaluation_per_item() {
    let c = compile_fixture("permission").unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let products = json!([
        {"type": "Product", "id": "p1", "name": "A", "stock": 3},
        {"type": "Product", "id": "p2", "name": "B", "stock": 0},
        {"type": "Product", "id": "p1", "name": "A", "stock": 3}
    ]);
    let out = render(
        &r,
        "pages/index",
        json!({ "products": products }),
        Can::default().with_check(counting_check(calls.clone())),
    );
    assert_eq!(out.html.matches(">Add</button>").count(), 2, "{}", out.html);
    assert_eq!(out.html.matches("Sign in to buy").count(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 2, "p1 and p2, each once");
    assert_eq!(out.authz_evals, 2);
    // Without a check every resource-based r-can denies.
    let out = render(
        &r,
        "pages/index",
        json!({ "products": products }),
        Can::actions(["cart.add"]),
    );
    assert_eq!(out.html.matches(">Add</button>").count(), 0);
    assert_eq!(out.authz_evals, 0);
}

/// A denied subtree runs nothing: a filter that would fail on its data is
/// never evaluated.
#[test]
fn a_denied_subtree_is_not_evaluated() {
    let c = compile_files(&[(
        "pages/index.html",
        r#"<p r-can="report.view">{{ total | money("AED") }}</p><i>end</i>"#,
    )])
    .unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    // `money` on a string fails the render when evaluated.
    let out = render(
        &r,
        "pages/index",
        json!({"total": "not a number"}),
        Can::default(),
    );
    assert_eq!(out.html.trim(), "<i>end</i>");
}

/// Fuel accounting on a 1,000-row page that checks every row (contract
/// Open 13, `docs/contracts/ops.md` section 17): each evaluation adds
/// [`CAN_FUEL`] to `fuel_used`, and a budget the checks exceed stops the
/// render with `Fuel` (the threat-model row "Template DoS",
/// `docs/24-threat-model.md`).
#[test]
fn fuel_accounting_with_1000_items() {
    let c = compile_files(&[(
        "pages/index.html",
        r#"<table><tr r-for="inv in invoices"><td>{{ inv.id }}</td><td r-can="invoice.refund" :resource="inv">refund</td></tr></table>"#,
    )])
    .unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let invoices: Vec<serde_json::Value> = (0..1000)
        .map(|i| json!({"type": "Invoice", "id": format!("inv_{i}"), "open": i % 2 == 0}))
        .collect();
    let check: Arc<CheckFn> = Arc::new(|_: &str, r: &serde_json::Value| r["open"] == json!(true));
    let data = json!({ "invoices": invoices });
    let plain = r
        .render(
            RenderTarget::Page("pages/index"),
            value(data.clone()),
            &cx(Can::default()),
            &RenderLimits::DEFAULT,
        )
        .unwrap();
    let started = Instant::now();
    let out = r
        .render(
            RenderTarget::Page("pages/index"),
            value(data.clone()),
            &cx(Can::default().with_check(check.clone())),
            &RenderLimits::DEFAULT,
        )
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(out.authz_evals, 1000);
    assert_eq!(out.html.matches(">refund</td>").count(), 500);
    assert!(
        out.fuel_used >= plain.fuel_used + 1000 * CAN_FUEL,
        "{} vs {}",
        out.fuel_used,
        plain.fuel_used
    );
    assert!(
        out.fuel_used < RenderLimits::DEFAULT.fuel,
        "fits the default budget"
    );
    eprintln!(
        "r-can with a resource, 1,000 rows: {elapsed:?} wall, {:.2} ms CPU, fuel {} of {} ({} for the checks)",
        out.ms,
        out.fuel_used,
        RenderLimits::DEFAULT.fuel,
        1000 * CAN_FUEL
    );
    // A budget that covers the page but not the checks stops at fuel.
    let tight = RenderLimits {
        fuel: plain.fuel_used + 500 * CAN_FUEL,
        ..RenderLimits::DEFAULT
    };
    let err = r
        .render(
            RenderTarget::Page("pages/index"),
            value(data),
            &cx(Can::default().with_check(check)),
            &tight,
        )
        .unwrap_err();
    let RenderError::Fuel(stats) = err else {
        panic!("expected Fuel, got {err:?}");
    };
    assert_eq!(stats.fuel_used, tight.fuel);
    assert!(
        stats.authz_evals > 0 && stats.authz_evals < 1000,
        "stopped before the last row: {stats:?}"
    );
}

/// The fragment cache key carries the action set's hash, so two users with
/// different sets never share an entry; a template that reaches an `r-can`
/// with a resource (itself or through its layout) has no key.
#[test]
fn fragment_cache_key() {
    let c = compile_files(&[
        (
            "pages/_layouts/main.html",
            r#"<!doctype html><html><head><title>t</title></head><body><nav r-can="admin.access">admin</nav><slot /></body></html>"#,
        ),
        (
            "pages/_layouts/owned.html",
            r#"<!doctype html><html><head><title>t</title></head><body><b r-can="doc.edit" :resource="doc">edit</b><slot /></body></html>"#,
        ),
        (
            "pages/index.html",
            r#"<r-layout use="main"><ul id="list" r-fragment="list"><li r-for="p in items">{{ p }}</li></ul></r-layout>"#,
        ),
        (
            "pages/doc.html",
            r#"<r-layout use="owned"><p id="body" r-fragment="body">{{ text }}</p></r-layout>"#,
        ),
        (
            "pages/row.html",
            r#"<ul id="rows" r-fragment="rows"><li r-for="p in items"><a r-can="item.open" :resource="p">open</a></li></ul>"#,
        ),
    ])
    .unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let admin = Can::actions(["admin.access", "item.list"]);
    let same = Can::actions(["item.list", "admin.access"]);
    let user = Can::actions(["item.list"]);
    let k_admin = r
        .fragment_cache_key("pages/index", "list", Some(&admin))
        .unwrap();
    assert_eq!(
        Some(k_admin.clone()),
        r.fragment_cache_key("pages/index", "list", Some(&same)),
        "order-free"
    );
    let k_user = r
        .fragment_cache_key("pages/index", "list", Some(&user))
        .unwrap();
    assert_ne!(k_admin, k_user);
    assert!(k_admin.starts_with("pages/index#list@"), "{k_admin}");
    assert_eq!(
        r.fragment_cache_key("pages/row", "rows", Some(&admin)),
        None,
        "resource-based r-can"
    );
    assert_eq!(
        r.fragment_cache_key("pages/doc", "body", Some(&admin)),
        None,
        "through the layout"
    );
    assert_eq!(r.fragment_cache_key("pages/nope", "x", Some(&admin)), None);
}

/// The action list of the compile result and of the renderer: what
/// `renox check` and the worker's prepare compare with the merged action
/// set.
#[test]
fn the_action_list_is_exported() {
    let c = compile_fixture("permission").unwrap();
    let expected: std::collections::BTreeSet<String> = ["admin.access", "cart.add"]
        .into_iter()
        .map(String::from)
        .collect();
    assert_eq!(c.actions(), expected);
    assert_eq!(Renderer::new(c.sources()).unwrap().actions(), &expected);
}

/// Compile snapshot of both forms: the emitted guard passes `none` without
/// a resource and the expression with one.
#[test]
fn emitted_guards() {
    let c = compile_files(&[(
        "pages/index.html",
        r#"<a r-can="admin.access" href="/admin">a</a><b r-cannot="cart.add" :resource="p">b</b>"#,
    )])
    .unwrap();
    let src = &c.templates["pages/index"].source;
    insta::assert_snapshot!(src);
}
