//! Rendering compiled templates: pages with layouts, fragments by block
//! name, components with slots, `r-can`, the CSP nonce, and the meter
//! numbers (`fuel_used`, `ms`). No V8.

mod common;

use std::sync::Arc;

use common::{compile_files, compile_fixture};
use minijinja::Value;
use renox_template::{
    CompiledTemplates, RenderContext, RenderError, RenderLimits, RenderTarget, Renderer,
};
use serde_json::json;

fn renderer(c: &CompiledTemplates) -> Renderer {
    Renderer::new(c.sources()).expect("renderer builds")
}

fn data(v: serde_json::Value) -> Value {
    serde_json::from_value::<Value>(v).expect("data")
}

/// The shop list page data: 100 products of 10 fields.
pub fn shop_data(n: usize) -> serde_json::Value {
    let products: Vec<serde_json::Value> = (0..n)
        .map(|i| {
            json!({
                "id": i, "slug": format!("product-{i}"), "name": format!("Product number {i}"),
                "price": 10.5 + i as f64, "stock": i % 7, "featured": i % 10 == 0,
                "category": "tools", "sku": format!("SKU-{i:05}"), "rating": 4.5, "currency": "AED"
            })
        })
        .collect();
    json!({
        "title": "Products", "query": "", "category": "tools", "cart_count": 2,
        "categories": [{"slug": "tools", "name": "Tools"}, {"slug": "garden", "name": "Garden"}],
        "products": products
    })
}

fn render_page(r: &Renderer, id: &str, v: serde_json::Value) -> String {
    r.render(
        RenderTarget::Page(id),
        data(v),
        &RenderContext::default(),
        &RenderLimits::DEFAULT,
    )
    .unwrap_or_else(|e| panic!("{id}: {e:?}"))
    .html
}

#[test]
fn shop_page_renders_with_layout_about_25_kb() {
    let c = compile_fixture("shop").unwrap();
    let r = renderer(&c);
    let out = r
        .render(
            RenderTarget::Page("pages/products/index"),
            data(shop_data(100)),
            &RenderContext {
                csp_nonce: Some("n0nce".into()),
                ..RenderContext::default()
            },
            &RenderLimits::DEFAULT,
        )
        .unwrap();
    let html = &out.html;
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert_eq!(html.matches("class=\"card").count(), 100);
    assert!(html.contains("AED\u{a0}19.50"), "money filter");
    assert!(html.contains("<script src=\"/static/htmx.min.js\" defer nonce=\"n0nce\">"));
    assert!(html.contains("<span id=\"cart-count\" dir=\"auto\">2</span>"));
    let kb = html.len() as f64 / 1024.0;
    assert!((18.0..34.0).contains(&kb), "{kb:.1} KB");
    assert!(
        out.fuel_used > 0 && out.fuel_used < RenderLimits::DEFAULT.fuel / 10,
        "fuel {}",
        out.fuel_used
    );
    assert!(out.ms > 0.0);
    eprintln!(
        "shop page: {kb:.1} KB, fuel {}, {:.3} ms CPU",
        out.fuel_used, out.ms
    );
}

/// A fragment request renders only the block, without the layout
/// (`artifact.md`, "Fragment selection" rule 1).
#[test]
fn fragment_renders_only_its_block() {
    let c = compile_fixture("shop").unwrap();
    let r = renderer(&c);
    let out = r
        .render(
            RenderTarget::Fragment {
                template: "pages/products/index",
                block: "product_list",
            },
            data(shop_data(20)),
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
        )
        .unwrap();
    assert!(
        out.html.starts_with("<ul id=\"product-list\""),
        "{}",
        out.html
    );
    assert!(out.html.trim_end().ends_with("</ul>"));
    assert_eq!(out.html.matches("class=\"card").count(), 20);
    assert!(!out.html.contains("<html") && !out.html.contains("site-header"));
    // A fragment defined in the layout renders from the page too.
    let badge = r
        .render(
            RenderTarget::Fragment {
                template: "pages/products/index",
                block: "cart_count",
            },
            data(shop_data(1)),
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
        )
        .unwrap();
    assert_eq!(badge.html, "<span id=\"cart-count\" dir=\"auto\">2</span>");
    let missing = r.render(
        RenderTarget::Fragment {
            template: "pages/products/index",
            block: "nope",
        },
        data(shop_data(1)),
        &RenderContext::default(),
        &RenderLimits::DEFAULT,
    );
    assert!(
        matches!(missing, Err(RenderError::NotFound(_))),
        "{missing:?}"
    );
}

/// Out-of-band fragments: several blocks, one evaluation.
#[test]
fn several_blocks_render_in_one_pass() {
    let c = compile_fixture("shop").unwrap();
    let r = renderer(&c);
    let (parts, stats) = r
        .render_blocks(
            "pages/products/index",
            &["product_list", "cart_count"],
            data(shop_data(3)),
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
        )
        .unwrap();
    assert_eq!(parts.len(), 2);
    assert!(parts[0].contains("Product number 2"));
    assert!(parts[1].contains("cart-count"));
    assert!(stats.fuel_used > 0);
}

#[test]
fn empty_list_renders_the_r_empty_branch() {
    let c = compile_fixture("shop").unwrap();
    let html = render_page(&renderer(&c), "pages/products/index", shop_data(0));
    assert!(html.contains("No products found"));
}

#[test]
fn autoescaping_and_r_html() {
    let c = compile_files(&[(
        "pages/index.html",
        "<p :title=\"x\">{{ x }}</p><div r-html=\"body\"></div>",
    )])
    .unwrap();
    let html = render_page(
        &renderer(&c),
        "pages/index",
        json!({"x": "<script>\"'", "body": "<b>ok</b>"}),
    );
    assert!(html.contains("&lt;script&gt;&quot;&#39;"), "{html}");
    assert!(!html.contains("<script>\""));
    assert!(html.contains("<b>ok</b>"));
}

/// Bound URLs cannot carry `javascript:` (`docs/24-threat-model.md`, XSS
/// through tenant data).
#[test]
fn bound_urls_refuse_script_schemes() {
    let c = compile_files(&[(
        "pages/index.html",
        "<a :href=\"u\">a</a><a href=\"{{ u }}\">b</a><a :href=\"ok\">c</a><a href=\"/p/{{ u }}\">d</a>",
    )])
    .unwrap();
    let html = render_page(
        &renderer(&c),
        "pages/index",
        json!({"u": " java\tscript:alert(1)", "ok": "https://example.com/a?b=1"}),
    );
    assert_eq!(
        html.matches("about:invalid#renox-unsafe-url").count(),
        2,
        "{html}"
    );
    assert!(
        html.contains("href=\"https://example.com/a?b=1\""),
        "{html}"
    );
    assert!(html.contains("href=\"/p/ java"), "{html}");
}

#[test]
fn components_slots_and_shadowed_names() {
    let c = compile_fixture("component").unwrap();
    let html = render_page(
        &renderer(&c),
        "pages/index",
        json!({"products": [{"name": "Hammer", "price": 5}], "featured": {"name": "Saw", "price": 12}, "product": "CALLER"}),
    );
    // Slot content sees the caller's `product`, not the prop.
    assert!(html.contains("Add CALLER"), "{html}");
    assert!(html.contains("<h3 dir=\"auto\">Hammer</h3>"));
    assert!(
        !html.contains("AED\u{a0}5.00"),
        "compact hides the price: {html}"
    );
    assert!(html.contains("US$\u{a0}12.00"), "{html}");
    assert!(html.contains("<span class=\"badge\" dir=\"auto\">New</span>"));
    assert!(
        html.contains("No extra content"),
        "fallback for the second card"
    );
}

#[test]
fn layouts_named_slots_and_fallbacks() {
    let c = compile_fixture("layout").unwrap();
    let r = renderer(&c);
    let index = render_page(
        &r,
        "pages/index",
        json!({"user": {"name": "Aisha"}, "news": []}),
    );
    assert!(index.contains("<title>Home · Renox</title>"), "{index}");
    assert!(index.contains("<p>No sidebar</p>"));
    assert!(index.contains("Welcome, Aisha."));
    assert!(index.contains(">0</span>"), "?? default");
    let about = render_page(&r, "pages/about", json!({}));
    assert!(about.contains("<title>Shop · Renox</title>"));
    assert!(
        about.contains("<aside><a href=\"/contact\">Contact</a></aside>"),
        "{about}"
    );
}

/// `r-can` calls the caller's hook; without one, everything is denied.
#[test]
fn r_can_uses_the_hook() {
    let c = compile_fixture("permission").unwrap();
    let r = renderer(&c);
    let d = json!({"products": [{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]});
    let denied = render_page(&r, "pages/index", d.clone());
    assert_eq!(denied.matches("Sign in to buy").count(), 2);
    assert!(!denied.contains("/admin"));
    let can: Arc<renox_template::CanFn> = Arc::new(|action: &str, resource: &Value| {
        action == "cart.add" && resource.get_attr("id").ok().and_then(|v| v.as_i64()) == Some(1)
    });
    let out = r
        .render(
            RenderTarget::Page("pages/index"),
            data(d),
            &RenderContext {
                can: Some(can),
                ..RenderContext::default()
            },
            &RenderLimits::DEFAULT,
        )
        .unwrap()
        .html;
    assert_eq!(out.matches(">Add</button>").count(), 1, "{out}");
    assert_eq!(out.matches("Sign in to buy").count(), 1);
}

/// Tenant data cannot replace the platform value (CSP nonce): a loader key
/// named `__renox` is ignored.
#[test]
fn data_cannot_override_the_nonce() {
    let c = compile_fixture("script-style").unwrap();
    let html = render_page(
        &renderer(&c),
        "pages/index",
        json!({"title": "t", "__renox": {"csp_nonce": "evil"}}),
    );
    assert!(!html.contains("evil"), "{html}");
    assert!(!html.contains("nonce="), "no nonce configured: {html}");
    assert!(
        html.contains("{{ \"not interpolated\" }}"),
        "script stays literal"
    );
}

#[test]
fn cross_module_slot_includes_providers() {
    let c = compile_fixture("cross-module-slot").unwrap();
    let html = render_page(&renderer(&c), "pages/admin", json!({}));
    assert!(
        html.contains("<nav><a href=\"/admin/orders\">Orders</a></nav>"),
        "{html}"
    );
}

#[test]
fn data_must_be_an_object() {
    let c = compile_files(&[("pages/index.html", "<p>x</p>")]).unwrap();
    let e = renderer(&c)
        .render(
            RenderTarget::Page("pages/index"),
            Value::from(vec![1, 2]),
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
        )
        .unwrap_err();
    assert!(matches!(e, RenderError::Failed { .. }), "{e:?}");
}

#[test]
fn renderer_refuses_missing_references() {
    let e = Renderer::new([("pages/a", "{% extends \"pages/_layouts/x\" %}")]).unwrap_err();
    assert!(e.reason.contains("unknown template"), "{e}");
}

/// The streaming interface writes into any `io::Write`.
#[test]
fn render_to_a_writer() {
    let c = compile_fixture("layout").unwrap();
    let mut out = Vec::new();
    let stats = renderer(&c)
        .render_to(
            RenderTarget::Page("pages/about"),
            data(json!({})),
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
            &mut out,
        )
        .unwrap();
    assert!(String::from_utf8(out).unwrap().contains("About us."));
    assert!(stats.fuel_used > 0);
}
