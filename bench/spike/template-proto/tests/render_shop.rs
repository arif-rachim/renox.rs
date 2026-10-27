//! End to end: transpile `shop-products.html` (the B6/B9 medium page),
//! compile with minijinja, render with 100 generated products.

use minijinja::context;

mod common;

/// 100 products × 10 fields, the B9 marshaling shape.
fn products(n: usize) -> Vec<minijinja::Value> {
    (0..n)
        .map(|i| {
            minijinja::Value::from_pairs([
                ("id", minijinja::Value::from(format!("p{i:03}"))),
                (
                    "name",
                    format!("Medjool dates {} kg #{i}", 1 + i % 5).into(),
                ),
                ("slug", format!("product-{i}").into()),
                ("price", (19.5 + i as f64 * 3.25).into()),
                ("currency", "AED".into()),
                ("stock", ((i * 7) % 13).into()),
                ("image", format!("/img/products/{i}.webp").into()),
                (
                    "category",
                    ["Dates", "Spices", "Coffee", "Honey"][i % 4].into(),
                ),
                ("rating", (3.0 + (i % 20) as f64 / 10.0).into()),
                ("featured", (i % 10 == 0).into()),
            ])
        })
        .collect()
}

fn render(n: usize) -> String {
    let mut env = common::env();
    let source = template_proto::transpile(&common::read("shop-products.html")).unwrap();
    env.add_template_owned("shop-products.html", source)
        .unwrap();
    let categories = vec![
        context! { slug => "dates", name => "Dates" },
        context! { slug => "spices", name => "Spices" },
    ];
    env.get_template("shop-products.html")
        .unwrap()
        .render(context! {
            title => "Products",
            query => "dates",
            category => "spices",
            categories => categories,
            cart_count => 2,
            products => products(n),
        })
        .unwrap()
}

#[test]
fn renders_100_cards_about_25_kb_with_no_directives() {
    let html = render(100);
    assert_eq!(html.matches("<li class=\"card").count(), 100);
    assert_eq!(
        html.matches("<li class=\"card\"").count()
            + html.matches("<li class=\"card card--").count(),
        100
    );
    let kb = html.len() as f64 / 1024.0;
    assert!(
        (20.0..=30.0).contains(&kb),
        "rendered size {kb:.1} KB, expected about 25 KB"
    );
    assert!(!html.contains(" r-"), "r-* attribute in output");
    assert!(!html.contains(" :"), ":* attribute in output");
    assert!(
        !html.contains("{{") && !html.contains("{%"),
        "template syntax in output"
    );
    // Spot checks: layout, filters, conditions, boolean attributes, hx-vals.
    assert!(html.starts_with("<!DOCTYPE html><html lang=\"en\" dir=\"ltr\">"));
    assert!(html.contains("<span class=\"price\">AED 22.75</span>"));
    assert!(html.contains("Out of stock"));
    assert!(html.contains("disabled hx-post"));
    assert!(html.contains("hx-vals='{\"productId\": \"p000\"}'"));
    assert!(html.contains("<option value=\"spices\" selected>Spices</option>"));
    assert!(html.contains("class=\"card card--featured\""));
}

#[test]
fn empty_list_renders_the_r_empty_branch() {
    let html = render(0);
    assert!(html.contains("<li class=\"empty\">No products found</li>"));
    assert!(!html.contains("result-count"));
}

#[test]
fn values_are_html_escaped() {
    let mut env = common::env();
    env.add_template_owned(
        "t.html",
        template_proto::transpile("<p :title=\"x\">{{ x }}</p>").unwrap(),
    )
    .unwrap();
    let out = env
        .get_template("t.html")
        .unwrap()
        .render(context! { x => "<script>\"'" })
        .unwrap();
    assert_eq!(
        out,
        "<p title=\"&lt;script&gt;&quot;&#x27;\">&lt;script&gt;&quot;&#x27;</p>"
    );
}

#[test]
fn product_list_fragment_renders_alone() {
    let mut env = common::env();
    let source = template_proto::transpile(&common::read("shop-products.html")).unwrap();
    env.add_template_owned("shop-products.html", source)
        .unwrap();
    let tmpl = env.get_template("shop-products.html").unwrap();
    let mut captured = tmpl
        .render_captured(context! { products => products(20) })
        .unwrap();
    let fragment = captured
        .with_state_mut(|state| state.render_block("product_list"))
        .unwrap();
    assert!(fragment.starts_with("<ul id=\"product-list\""));
    assert_eq!(fragment.matches("<li class=\"card").count(), 20);
    assert!(!fragment.contains("<html"));
}
