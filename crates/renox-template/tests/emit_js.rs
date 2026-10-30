//! Render path B (`src/emit_js`, #42) against path A on the fixture set:
//! every page, layout, partial, and fragment, rendered by the Rust renderer
//! and by the emitted JavaScript module, with several data sets and the
//! three platform locales, must be byte-equal (ADR D7, B8). A render that
//! fails on one path must fail on the other.
//!
//! The JavaScript side runs in `node` (or `bun`, or `RENOX_JS_RUNTIME`), as
//! a subprocess: this crate never links V8.

mod common;

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use common::{compile_files, compile_fixture, fixtures_dir};
use minijinja::Value;
use renox_template::emit_js::emit_module;
use renox_template::{
    CompiledTemplates, Locale, RenderContext, RenderLimits, RenderTarget, Renderer,
};
use serde_json::json;

/// The fixtures path B does not cover, and why (`src/emit_js`, module
/// docs).
const NOT_COVERED: &[(&str, &str)] = &[("filter", "filter `date`")];

fn js_runtime() -> String {
    if let Ok(r) = std::env::var("RENOX_JS_RUNTIME") {
        return r;
    }
    for r in ["node", "bun"] {
        if Command::new(r).arg("--version").output().is_ok() {
            return r.to_string();
        }
    }
    panic!("tests/emit_js.rs needs node or bun on PATH (or RENOX_JS_RUNTIME)");
}

/// Data sets: realistic values, hostile strings, edge numbers, nulls, and
/// nothing at all.
fn data_sets() -> Vec<serde_json::Value> {
    let product = |i: i64| {
        json!({
            "id": i, "slug": format!("p-{i}"), "name": format!("Product {i}"), "sku": format!("SKU-{i:04}"),
            "price": 10.125 + i as f64, "stock": i % 3, "featured": i % 2 == 0, "url": format!("/products/{i}"),
            "ok": true, "hidden": i == 1, "extra_class": "x-extra", "plan": "pro", "category": "dates"
        })
    };
    let products: Vec<_> = (0..5).map(product).collect();
    let rich = json!({
        "title": "Products", "query": "dates", "q": "dates & co", "category": "dates", "cart_count": 3,
        "categories": [{"slug": "dates", "name": "Dates", "category": "dates", "n": 20}, {"slug": "coffee", "name": "Coffee", "category": "coffee", "n": 7}],
        "products": products, "featured": product(9), "product": product(7), "p": product(4),
        "user": {"name": "Aisha", "agreed": false, "nickname": null, "plan": "free"},
        "cart": {"items": [1, 2], "total": 12.5}, "order": {"status": "pending", "expired": false, "gift": true},
        "tab": "home", "count": 7, "note": "multi\nline", "specs": [{"key": "Weight", "value": "1 kg"}],
        "warranty": "2 years", "news": [{"title": "Eid sale"}], "request_id": "req_1", "status": 500,
        "message": "Oops", "post": {"body": "<b>bold</b> & <i>it</i>"}, "rows": [1, 2], "cols": ["a", "b"],
        "orders": [{"id": 1, "total": 1234.5}, {"id": 2, "total": -0.004}, {"id": 3, "total": 2.5}],
        "total": 100, "price_min": 0.5, "price_max": 1999.995
    });
    let hostile = json!({
        "title": "<script>alert('x')</script>", "query": "\"><img src=x onerror=1>", "q": "a/b?c=d&e='f'",
        "category": "<>", "cart_count": "1</span>",
        "categories": [{"slug": "\"q\"", "name": "Ḍates — تمر", "category": "x", "n": 1.5}],
        "products": [{"id": "1\"", "slug": "javascript:alert(1)", "name": "<b>N</b>", "price": "12.30",
            "stock": 0, "featured": "yes", "url": " JaVaScRiPt:alert(1)", "ok": 1, "hidden": 0}],
        "p": {"name": "مرحبا 😀", "url": "java\tscript:x", "price": 1e21, "sku": null, "ok": [], "hidden": {}},
        "user": {"name": "O'Neil & \"Sons\"", "agreed": true, "nickname": "N", "plan": null},
        "cart": {"items": [], "total": 0}, "order": {"status": "paid", "gift": false},
        "post": {"body": "<script>x</script>"}, "featured": {"name": "F", "price": -1234567.891},
        "orders": [], "note": "</textarea><b>", "count": -0.0, "specs": [], "news": [], "rows": [], "cols": [],
        "price_min": 0.125, "price_max": 0.375, "total": 18446744073709551615u64, "tab": null
    });
    let nulls = json!({
        "title": null, "products": null, "categories": null, "p": null, "user": null, "cart": null,
        "order": null, "news": null, "orders": null, "cart_count": null, "price_min": null
    });
    vec![rich, hostile, nulls, json!({})]
}

fn can(action: &str, resource: &serde_json::Value) -> bool {
    action == "admin.access"
        || action == "users.manage"
        || (action == "cart.add" && resource.get("stock").and_then(|s| s.as_i64()).unwrap_or(0) > 0)
}

const LOCALES: &[(&str, Locale)] = &[
    ("en-AE", Locale::EN_AE),
    ("ar-AE", Locale::AR_AE),
    ("ar-AE-u-nu-arab", Locale::AR_AE_ARABIC_DIGITS),
];

/// Path A: `Ok(html)` or `Err(())` for any render error.
fn render_a(
    r: &Renderer,
    target: RenderTarget<'_>,
    data_json: &str,
    locale: Locale,
) -> Result<String, ()> {
    let cx = RenderContext {
        locale,
        csp_nonce: Some("n0nce".into()),
        csrf_token: Some("t0ken".into()),
        can: Some(Arc::new(
            renox_template::Can::actions(["admin.access", "users.manage"])
                .with_check(Arc::new(|a: &str, res: &serde_json::Value| can(a, res))),
        )),
        ..RenderContext::default()
    };
    let value = serde_json::from_str::<Value>(data_json).expect("data");
    r.render(target, value, &cx, &RenderLimits::DEFAULT)
        .map(|o| o.html)
        .map_err(|_| ())
}

const DRIVER: &str = r#"
import { readFileSync } from "node:fs";
import { render, renderFragment } from "./templates.mjs";
const can = (action, r) => action === "admin.access" || action === "users.manage" ||
  (action === "cart.add" && r !== null && typeof r === "object" && Number.isInteger(r.stock) && r.stock > 0);
const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = cases.map((c) => {
  const cx = { locale: c.locale, csp_nonce: "n0nce", csrf_token: "t0ken", can };
  try {
    const html = c.block === null ? render(c.id, c.data, cx) : renderFragment(c.id, c.block, c.data, cx);
    return { ok: html, json: JSON.stringify(c.data) };
  } catch (e) {
    return { err: String(e && e.message), json: JSON.stringify(c.data) };
  }
});
process.stdout.write(JSON.stringify(out));
"#;

/// Path B for every case, in one JS process. Each result comes with the
/// case's data as `JSON.stringify` writes it: what the cell's render op
/// hands path A (`-0` becomes `0`, `1e21` stays a float).
fn render_b(
    name: &str,
    module: &str,
    cases: &[serde_json::Value],
) -> Vec<(Result<String, String>, String)> {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("emit_js-{name}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("templates.mjs"), module).unwrap();
    std::fs::write(dir.join("driver.mjs"), DRIVER).unwrap();
    std::fs::write(dir.join("cases.json"), serde_json::to_vec(cases).unwrap()).unwrap();
    let out = Command::new(js_runtime())
        .arg(dir.join("driver.mjs"))
        .arg(dir.join("cases.json"))
        .output()
        .expect("JS runtime starts");
    assert!(
        out.status.success(),
        "{name}: JS failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let results: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).expect("JSON");
    results
        .into_iter()
        .map(|r| {
            let json = r["json"].as_str().expect("json").to_string();
            match r.get("ok") {
                Some(s) => (Ok(s.as_str().expect("string").to_string()), json),
                None => (Err(r["err"].as_str().unwrap_or("").to_string()), json),
            }
        })
        .collect()
}

/// Renders every target of `compiled` both ways; returns the number of
/// byte-equal comparisons.
fn compare(name: &str, compiled: &CompiledTemplates, data: &[serde_json::Value]) -> usize {
    let module = emit_module(compiled).unwrap_or_else(|e| panic!("{name}: {e}"));
    let renderer = Renderer::new(compiled.sources()).expect("renderer");
    let mut targets: Vec<(String, Option<String>)> = Vec::new();
    for (id, t) in &compiled.templates {
        targets.push((id.clone(), None));
        for block in t.fragments.iter().flat_map(|f| f.keys()) {
            targets.push((id.clone(), Some(block.clone())));
        }
    }
    let mut cases = Vec::new();
    for (id, block) in &targets {
        for d in data {
            for (tag, _) in LOCALES {
                cases.push(json!({ "id": id, "block": block, "data": d, "locale": tag }));
            }
        }
    }
    let got = render_b(name, &module, &cases);
    assert_eq!(got.len(), cases.len());
    let mut equal = 0;
    for (case, (b, data_json)) in cases.iter().zip(&got) {
        let id = case["id"].as_str().unwrap();
        let target = match case["block"].as_str() {
            None => RenderTarget::Page(id),
            Some(block) => RenderTarget::Fragment {
                template: id,
                block,
            },
        };
        let locale = LOCALES
            .iter()
            .find(|(t, _)| *t == case["locale"])
            .map(|(_, l)| *l)
            .unwrap();
        let a = render_a(&renderer, target, data_json, locale);
        match (&a, b) {
            (Ok(a), Ok(b)) => {
                assert_eq!(
                    a, b,
                    "{name}: {id} block {} locale {} data {data_json}",
                    case["block"], case["locale"]
                );
                equal += 1;
            }
            (Err(()), Err(_)) => {}
            // Path A evaluates the whole page before it renders a block
            // (`Renderer::render_to`); path B runs the block alone. Allowed
            // only when the whole page fails on path A too.
            (Err(()), Ok(_))
                if case["block"].is_string()
                    && render_a(&renderer, RenderTarget::Page(id), data_json, locale).is_err() => {}
            (a, b) => panic!(
                "{name}: {id} block {} locale {}: path A {a:?}, path B {b:?}, data {data_json}",
                case["block"], case["locale"]
            ),
        }
    }
    equal
}

#[test]
fn both_paths_render_the_fixture_set_byte_equal() {
    let mut names: Vec<String> = std::fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    let data = data_sets();
    let mut total = 0;
    for name in &names {
        let compiled = compile_fixture(name).unwrap_or_else(|d| panic!("{name}: {d:?}"));
        if let Some((_, reason)) = NOT_COVERED.iter().find(|(n, _)| n == name) {
            let err = emit_module(&compiled).unwrap_err();
            assert_eq!(&err.reason, reason, "{name}");
            continue;
        }
        if name == "evil-nested-loops" {
            continue; // covered by the limits test below
        }
        let n = compare(name, &compiled, &data);
        assert!(n > 0, "{name}: no successful render to compare");
        total += n;
    }
    assert!(total > 200, "only {total} comparisons");
}

/// How values print: booleans, none, lists and maps, floats, quoting.
#[test]
fn values_print_like_path_a() {
    let compiled = compile_files(&[(
        "pages/index.html",
        r#"<p>{{ b }} {{ n }} {{ xs }} {{ m }} {{ f }} {{ big }} {{ tiny }} {{ b ~ n ~ u }} {{ xs | join(", ") }} {{ m | json }} {{ s | length }} {{ xs | first }} {{ xs | last }} {{ s | upper }} {{ f | number }} {{ neg | number(1) }} {{ 'a' in s }} {{ 2 in xs }} {{ u | default('d') }} {{ n | default('d') }}</p><i r-for="k in m">{{ k }}={{ m[k] }};</i><i r-for="c in s">[{{ c }}]</i>"#,
    )])
    .unwrap();
    let data = vec![
        json!({ "b": true, "n": null, "xs": [1, 2.5, "it's", "say \"hi\"", null, true, [1], {"k": "v"}, 1e-7, 1e17],
                "m": {"z": 1, "a": "x\ty", "é": false}, "f": 1234.5678, "big": 1e21, "tiny": 1e-7, "s": "abc😀",
                "neg": -0.04 }),
        json!({ "b": false, "xs": [], "m": {}, "s": "", "f": 0.125, "neg": -2.25 }),
    ];
    assert!(compare("values", &compiled, &data) > 0);
}

/// The shop list page at the B8 sizes: 100 and 1,000 items.
#[test]
fn shop_page_is_byte_equal_at_b8_sizes() {
    let compiled = compile_fixture("shop").unwrap();
    let products = |n: usize| -> Vec<serde_json::Value> {
        (0..n)
            .map(|i| {
                json!({
                    "id": i, "slug": format!("product-{i}"), "name": format!("Product number {i}"),
                    "price": 10.5 + i as f64 / 8.0, "stock": i % 7, "featured": i % 10 == 0
                })
            })
            .collect()
    };
    let data: Vec<_> = [100, 1000]
        .iter()
        .map(|n| {
            json!({
                "title": "Products", "query": "", "category": "tools", "cart_count": 2,
                "categories": [{"slug": "tools", "name": "Tools"}], "products": products(*n)
            })
        })
        .collect();
    assert!(compare("shop-b8", &compiled, &data) > 0);
}

/// Components with slots and shadowed names, layouts with slot blocks.
#[test]
fn components_and_layouts_scope_like_path_a() {
    let compiled = compile_files(&[
        (
            "partials/card.html",
            r#"<r-props item="Item" label="string = 'x'" /><div>{{ label }}: {{ item.name }} <slot name="foot"></slot><slot>none</slot></div>"#,
        ),
        (
            "pages/_layouts/main.html",
            "<html><head><title><slot name=\"title\">T</slot></title></head><body><slot /><slot name=\"side\">S</slot></body></html>",
        ),
        (
            "pages/index.html",
            r#"<r-layout use="main"><r-group slot="title">{{ item.name }}</r-group><div r-for="item in items"><x-card :item="item" label="L"><b slot="foot">{{ item.name }}</b>{{ label ?? 'outer' }}</x-card></div><p>{{ item.name }}</p></r-layout>"#,
        ),
    ])
    .unwrap();
    let data = vec![
        json!({ "item": {"name": "outer"}, "label": "lbl", "items": [{"name": "a"}, {"name": "b"}] }),
        json!({ "items": [] }),
    ];
    assert!(compare("scopes", &compiled, &data) > 0);
}

/// B13 on path B: the iteration limit stops the nested loops (fuel has no
/// JS equivalent; the isolate CPU limit is the bound,
/// `docs/24-threat-model.md` "Template DoS").
#[test]
fn nested_loops_stop_at_the_iteration_limit() {
    let compiled = compile_fixture("evil-nested-loops").unwrap();
    let rows: Vec<i64> = (0..10_000).collect();
    let data = json!({ "rows": rows, "cols": rows });
    let module = emit_module(&compiled).unwrap();
    let got = render_b(
        "evil",
        &module,
        &[json!({ "id": "pages/index", "block": null, "data": data, "locale": "en-AE" })],
    );
    assert_eq!(got[0].0, Err("render iterations limit".to_string()));
}

#[test]
fn every_fixture_is_listed_or_covered() {
    for (name, _) in NOT_COVERED {
        assert!(fixtures_dir().join(name).is_dir(), "{name}");
    }
}
