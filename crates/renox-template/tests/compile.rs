//! One fixture per row of the syntax table (`docs/08-template-engine.md`,
//! "Syntax"): each directory under `tests/fixtures/` is an app's template
//! files; the compiled sources and the fragment maps are snapshot-tested.
//! No V8.

mod common;

use std::path::Path;

use common::{compile_fixture, fixtures_dir};

/// Every fixture directory compiles without diagnostics and matches its
/// snapshot (`tests/snapshots/compile__<fixture>.snap`).
#[test]
fn fixtures_match_snapshots() {
    let mut names: Vec<String> = std::fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| fixtures_dir().join(n).is_dir())
        .collect();
    names.sort();
    assert!(names.len() >= 20, "fixtures: {names:?}");
    for name in names {
        let compiled =
            compile_fixture(&name).unwrap_or_else(|d| panic!("{name}: {}", common::show(&d)));
        let mut text = String::new();
        for (id, t) in &compiled.templates {
            text.push_str(&format!("== {id} ({:?})\n{}\n", t.kind, t.source));
            if let Some(f) = &t.fragments {
                text.push_str(&format!(
                    "-- fragments: {}\n",
                    serde_json::to_string(f).unwrap()
                ));
            }
        }
        insta::assert_snapshot!(name.clone(), text);
    }
}

/// Every syntax row of the table has a fixture directory.
#[test]
fn every_syntax_row_has_a_fixture() {
    let rows = [
        ("interpolation", "{{ user.name }}"),
        ("filter", "| money"),
        ("r-html", "r-html"),
        ("condition", "r-else-if"),
        ("loop", "r-for"),
        ("loop-index", "(p, i)"),
        ("loop-empty", "r-empty"),
        ("bind-attr", ":href"),
        ("bind-class", ":class"),
        ("bind-boolean", ":disabled"),
        ("fragment", "r-fragment"),
        ("group", "<r-group"),
        ("component", "<x-product-card"),
        ("component", "<r-props"),
        ("component", "slot=\"actions\""),
        ("layout", "<r-layout"),
        ("cross-module-slot", "<r-slot"),
        ("permission", "r-cannot"),
        ("module-component", "<billing:plan-badge"),
        ("module-component", "overrides/"),
        ("script-style", "<script>"),
        ("dir-auto", "{{ note }}"),
        ("static-merge", "<footer>"),
    ];
    for (fixture, needle) in rows {
        let dir = fixtures_dir().join(fixture);
        let all = read_all(&dir);
        assert!(all.contains(needle), "fixture {fixture} has no `{needle}`");
    }
}

fn read_all(dir: &Path) -> String {
    let mut s = String::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        s.push_str(&p.to_string_lossy());
        if p.is_dir() {
            s.push_str(&read_all(&p));
        } else {
            s.push_str(&std::fs::read_to_string(&p).unwrap());
        }
    }
    s
}

/// Consecutive static HTML compiles to a single `EmitRaw` instruction
/// (compile pipeline step 4, "Consecutive static text becomes one chunk").
#[test]
fn static_html_is_one_chunk() {
    let compiled = compile_fixture("static-merge").unwrap();
    let source = &compiled.templates["pages/index"].source;
    assert!(!source.contains("{%") && !source.contains("{{"));
    let mut env = minijinja::Environment::new();
    env.add_template("t", source).unwrap();
    let tmpl = env.get_template("t").unwrap();
    let debug = format!("{tmpl:?}");
    assert_eq!(debug.matches("EmitRaw").count(), 1, "{debug}");
}

/// The fragment map: `(page, fragment) -> block` with the HX-Target id,
/// including fragments defined in the layout (`artifact.md`, "Templates").
#[test]
fn fragment_map_includes_layout_fragments_and_targets() {
    let compiled = compile_fixture("layout").unwrap();
    let index = compiled.templates["pages/index"]
        .fragments
        .as_ref()
        .unwrap();
    assert_eq!(index["news"].target.as_deref(), Some("news"));
    assert_eq!(index["cart_badge"].target.as_deref(), Some("cart-badge"));
    let about = compiled.templates["pages/about"]
        .fragments
        .as_ref()
        .unwrap();
    assert!(about.contains_key("cart_badge"));
    assert!(
        compiled.templates["pages/_layouts/main"]
            .fragments
            .is_none()
    );
    let manifest = compiled.manifest_entries();
    assert_eq!(manifest["pages/_404"]["kind"], "not_found");
    assert_eq!(manifest["pages/_error"]["kind"], "error");
    assert_eq!(manifest["pages/_layouts/main"]["kind"], "layout");
    assert_eq!(
        manifest["pages/index"]["fragments"]["cart_badge"]["target"],
        "cart-badge"
    );
    let files: Vec<String> = compiled.files().map(|(p, _)| p).collect();
    assert!(files.contains(&"pages/_layouts/main.jinja".to_string()));
}

/// Module overrides: `overrides/<module>/partials/x.html` replaces the
/// module's file.
#[test]
fn overrides_replace_module_partials() {
    let compiled = compile_fixture("module-component").unwrap();
    let source = &compiled.templates["pages/index"].source;
    assert!(source.contains("Your invoice"), "{source}");
    assert!(!source.contains(">Invoice<"), "{source}");
    assert!(source.contains("user.plan"));
}

/// Every emitted `<script>` and `<style>` carries the per-request nonce
/// (`docs/04-isolation-security.md`, CSP).
#[test]
fn nonce_placeholder_on_every_script_and_style() {
    for fixture in ["script-style", "layout", "shop"] {
        let compiled = compile_fixture(fixture).unwrap();
        for (id, t) in &compiled.templates {
            let opens = t.source.matches("<script").count() + t.source.matches("<style").count();
            let nonces = t
                .source
                .matches("nonce=\"{{ __renox.csp_nonce }}\"")
                .count();
            assert_eq!(opens, nonces, "{fixture} {id}: {}", t.source);
        }
    }
}
