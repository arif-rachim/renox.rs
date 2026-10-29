//! #233: translations (`t`, `<r-t>`), the page's `<html lang dir>`, the
//! locale-aware filters, and the GCC formatters, for `en` and `ar` of the
//! same template.

mod common;

use std::sync::{Arc, Mutex};

use common::compile_files;
use minijinja::Value;
use renox_template::{Catalogs, Dir, RenderContext, RenderLimits, RenderTarget, Renderer};
use serde_json::json;

/// 2026-10-28T10:30:00Z.
const NOW: i64 = 1_793_183_400_000;

const LAYOUT: &str =
    r#"<!DOCTYPE html><html><head><title>Shop</title></head><body><slot></slot></body></html>"#;

const PAGE: &str = r#"<r-layout use="main">
<h1><r-t key="cart.title" /></h1>
<p><r-t key="cart.items" :count="n" /></p>
<p><r-t key="cart.items" :count="zero" /></p>
<p><r-t key="cart.items" :count="two" /></p>
<p><r-t key="cart.items" :count="few" /></p>
<p><r-t key="cart.items" :count="many" /></p>
<p>{{ "cart.greeting" | t(name=user) }}</p>
<p>{{ total | money }}</p>
<p>{{ big | number }}</p>
<p>{{ day | date }}</p>
<p>{{ phone | phone_ae }}</p>
<p>{{ eid | emirates_id }}</p>
<p>{{ trn | trn }}</p>
<p><r-t key="auth.only_in_module" /></p>
<p><r-t key="nope.missing" /></p>
</r-layout>"#;

const EN_APP: &str = r#"{
  "cart": {
    "title": "Your cart",
    "items": "{count, plural, =0 {Your cart is empty} one {# item} other {# items}}",
    "greeting": "Hello, {name}"
  }
}"#;

const AR_APP: &str = r#"{
  "_meta": { "machine_translated": ["cart.greeting"] },
  "cart": {
    "title": "سلة التسوق",
    "items": "{count, plural, zero {السلة فارغة} one {منتج واحد} two {منتجان} few {# منتجات} many {# منتجًا} other {# منتج}}",
    "greeting": "مرحبًا، {name}"
  }
}"#;

const EN_AUTH: &str = r#"{ "auth": { "only_in_module": "Signed in", "title": "module title" }, "cart": { "title": "module cart" } }"#;

fn renderer(missing: Arc<Mutex<Vec<(String, String)>>>) -> Renderer {
    let c = compile_files(&[
        ("pages/_layouts/main.html", LAYOUT),
        ("pages/cart.html", PAGE),
    ])
    .unwrap_or_else(|d| panic!("{}", common::show(&d)));
    let mut cats = Catalogs::new();
    cats.add("auth", "en", EN_AUTH).unwrap();
    cats.add("app", "en", EN_APP).unwrap();
    cats.add("app", "ar", AR_APP).unwrap();
    let cats = cats.on_missing(Arc::new(move |l: &str, k: &str| {
        missing.lock().unwrap().push((l.to_string(), k.to_string()))
    }));
    Renderer::new(c.sources())
        .unwrap()
        .with_catalogs(Arc::new(cats))
}

fn data() -> Value {
    serde_json::from_value(json!({
        "n": 1, "zero": 0, "two": 2, "few": 3, "many": 11,
        "user": "Mariam <b>",
        "total": 1234.5,
        "big": 1234567,
        "day": "2026-10-28",
        "phone": "0501234567",
        "eid": "784198012345671",
        "trn": "100234567890003"
    }))
    .unwrap()
}

fn render(r: &Renderer, lang: &str, dir: Option<Dir>) -> String {
    r.render(
        RenderTarget::Page("pages/cart"),
        data(),
        &RenderContext {
            lang: Some(lang.to_string()),
            dir,
            now_ms: NOW,
            utc_offset_minutes: 240,
            ..RenderContext::default()
        },
        &RenderLimits::DEFAULT,
    )
    .unwrap()
    .html
}

#[test]
fn en_and_ar_snapshots() {
    let missing = Arc::new(Mutex::new(Vec::new()));
    let r = renderer(missing.clone());
    insta::assert_snapshot!("cart_en", render(&r, "en", None));
    insta::assert_snapshot!("cart_ar", render(&r, "ar-AE", None));
    insta::assert_snapshot!("cart_ar_arab_digits", render(&r, "ar-AE-u-nu-arab", None));
}

#[test]
fn html_lang_and_dir_follow_the_render_input() {
    let r = renderer(Arc::new(Mutex::new(Vec::new())));
    assert!(render(&r, "en", None).contains(r#"<html lang="en" dir="ltr">"#));
    let ar = render(&r, "ar-AE", None);
    assert!(ar.contains(r#"<html lang="ar-AE" dir="rtl">"#), "{ar}");
    // Arabic plural forms and AED.
    for s in [
        "منتج واحد",
        "منتجان",
        "3 منتجات",
        "11 منتجًا",
        "السلة فارغة",
        "1,234.50\u{a0}د.إ.",
    ] {
        assert!(ar.contains(s), "{s} in {ar}");
    }
    // An explicit direction wins.
    assert!(render(&r, "ar", Some(Dir::Ltr)).contains(r#"<html lang="ar" dir="ltr">"#));
    // Eastern Arabic digits by locale setting.
    let digits = render(&r, "ar-AE-u-nu-arab", None);
    assert!(digits.contains("١٬٢٣٤٫٥٠"), "{digits}");
}

/// A missing key renders the key and is reported once per deployment (the
/// renderer is per deployment), whatever the number of renders.
#[test]
fn missing_key_renders_the_key_and_is_reported_once() {
    let missing = Arc::new(Mutex::new(Vec::new()));
    let r = renderer(missing.clone());
    for _ in 0..3 {
        let html = render(&r, "en", None);
        assert!(html.contains(">nope.missing</p>"), "{html}");
    }
    render(&r, "ar-AE", None);
    let seen = missing.lock().unwrap().clone();
    assert_eq!(
        seen,
        [
            ("en".to_string(), "nope.missing".to_string()),
            ("ar-AE".to_string(), "nope.missing".to_string())
        ]
    );
}

/// Catalog text and arguments are escaped like any value: a catalog or an
/// argument cannot inject markup.
#[test]
fn messages_are_escaped_and_app_overrides_modules() {
    let r = renderer(Arc::new(Mutex::new(Vec::new())));
    let en = render(&r, "en", None);
    assert!(en.contains("Hello, Mariam &lt;b&gt;"), "{en}");
    // The app's `cart.title` overrides the module's; a module-only key is found.
    assert!(en.contains("Your cart") && !en.contains("module cart"));
    assert!(en.contains("Signed in"));
    // `ar` falls back to `en` for a key the Arabic catalogs lack.
    assert!(render(&r, "ar", None).contains("Signed in"));
}

#[test]
fn r_t_needs_a_key() {
    let e = compile_files(&[("pages/a.html", r#"<p><r-t /></p>"#)]).unwrap_err();
    assert!(
        common::show(&e).contains("`<r-t>` needs `key`"),
        "{}",
        common::show(&e)
    );
    let e = compile_files(&[("pages/a.html", r#"<p><r-t key="a.b">x</r-t></p>"#)]).unwrap_err();
    assert!(common::show(&e).contains("takes no content"));
}

/// Catalog lookups go through the `t` filter, so they consume fuel like any
/// other filter: a template of many lookups runs out under a small budget.
#[test]
fn catalog_lookups_count_as_fuel() {
    let src = format!("<p>{}</p>", "<r-t key=\"cart.title\" />".repeat(500));
    let c = compile_files(&[("pages/many.html", &src)]).unwrap();
    let mut cats = Catalogs::new();
    cats.add("app", "en", EN_APP).unwrap();
    let r = Renderer::new(c.sources())
        .unwrap()
        .with_catalogs(Arc::new(cats));
    let cx = RenderContext::default();
    let ok = r
        .render(
            RenderTarget::Page("pages/many"),
            Value::from(()),
            &cx,
            &RenderLimits::DEFAULT,
        )
        .unwrap();
    assert!(ok.fuel_used >= 500, "{}", ok.fuel_used);
    let small = RenderLimits {
        fuel: 100,
        ..RenderLimits::DEFAULT
    };
    let e = r
        .render(
            RenderTarget::Page("pages/many"),
            Value::from(()),
            &cx,
            &small,
        )
        .unwrap_err();
    assert!(e.is_limit(), "{e:?}");
}
