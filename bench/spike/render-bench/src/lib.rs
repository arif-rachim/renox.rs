//! B6 first cut (issue #11): the render stage of the shop medium page in
//! Rust, with no HTTP, SQLite or isolate. The page is the `shop` fixture of
//! `crates/renox-template` (`tests/fixtures/shop`, the B6 medium page of
//! issue #9), compiled once by `renox_template::Compiler`; products arrive
//! already as `minijinja::Value`, as they would after B9's marshaling step.
//!
//! The environment is a plain minijinja one (no render limits), so the
//! numbers stay comparable with the first cut; the compiler-emitted
//! `__loop` and `__url` filters are identity stubs here.

use std::path::Path;

use minijinja::{Environment, UndefinedBehavior, Value, context};

pub const PAGE: &str = "pages/products/index";
pub const LAYOUT: &str = "pages/_layouts/main";
pub const FRAGMENT: &str = "pages/products/index#product_list";
pub const FRAGMENT_BLOCK: &str = "product_list";

/// Fuel budget for the "fuel enabled" measurement: large enough never to run
/// out, so only the tracking overhead is measured. Not `u64::MAX`: minijinja
/// keeps the remaining fuel as an `isize`, and `u64::MAX` wraps to -1.
pub const FUEL_BUDGET: u64 = 1 << 40;

/// The compiled shop fixture: `(template id, minijinja source)`.
fn compiled() -> renox_template::CompiledTemplates {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../crates/renox-template/tests/fixtures/shop");
    let project = renox_template::TemplateProject::from_dir(&dir).expect("shop fixture");
    renox_template::Compiler::default()
        .compile(&project)
        .unwrap_or_else(|d| panic!("{d:?}"))
}

/// The block body of `{% block <name> %}…{% endblock %}` in compiled
/// source, so the fragment can be compiled and rendered on its own, the way an
/// htmx request for one fragment would be served. Assumes no nested blocks,
/// which holds for `product_list`.
pub fn block_source(source: &str, name: &str) -> String {
    let open = format!("{{% block {name} %}}");
    let start = source.find(&open).expect("block start") + open.len();
    let end = start + source[start..].find("{% endblock %}").expect("block end");
    source[start..end].to_string()
}

/// Environment with the layout, the page, the page's `product_list` block as
/// its own template, and stub `money`/`date` filters. `fuel` sets
/// minijinja's fuel limit.
pub fn env(fuel: Option<u64>) -> Environment<'static> {
    let mut env = Environment::new();
    env.set_auto_escape_callback(|_| minijinja::AutoEscape::Html);
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    env.set_fuel(fuel);
    env.add_filter("money", |v: Value| {
        format!("AED {:.2}", f64::try_from(v).unwrap_or(0.0))
    });
    env.add_filter("date", |v: Value| v.to_string());
    env.add_filter("__loop", |v: Value| v);
    env.add_filter("__url", |v: Value| v);
    let c = compiled();
    env.add_template_owned(LAYOUT, c.templates[LAYOUT].source.clone())
        .expect("layout compiles");
    let page = c.templates[PAGE].source.clone();
    env.add_template_owned(FRAGMENT, block_source(&page, FRAGMENT_BLOCK))
        .expect("fragment compiles");
    env.add_template_owned(PAGE, page).expect("page compiles");
    env
}

/// `n` deterministic products of 10 fields (the shape of the F0 prototype's
/// `render_shop` test).
pub fn products(n: usize) -> Value {
    Value::from(
        (0..n)
            .map(|i| {
                Value::from_pairs([
                    ("id", Value::from(format!("p{i:03}"))),
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
            .collect::<Vec<_>>(),
    )
}

/// The page context with `n` products.
pub fn page_context(n: usize) -> Value {
    context! {
        title => "Products",
        query => "dates",
        category => "spices",
        categories => vec![
            context! { slug => "dates", name => "Dates" },
            context! { slug => "spices", name => "Spices" },
        ],
        cart_count => 2,
        products => products(n),
    }
}
