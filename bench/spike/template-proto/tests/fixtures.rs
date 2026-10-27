//! String in, string out: every `tests/fixtures/<name>.html` must transpile to
//! exactly `<name>.expected.j2`, and that output must compile with minijinja.
//! No V8 is linked (docs/12-developer-experience.md, rule 4).

mod common;

#[test]
fn every_fixture_matches_its_expected_output() {
    let mut checked = 0;
    let mut failures = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(common::fixtures())
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    let env = common::env();
    for path in entries
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "html"))
    {
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let html = std::fs::read_to_string(path).unwrap();
        let expected = std::fs::read_to_string(path.with_extension("expected.j2"))
            .unwrap_or_else(|_| panic!("{name}: missing {name}.expected.j2"));
        match template_proto::transpile(&html) {
            Ok(actual) if actual == expected => {
                let mut env = env.clone();
                if let Err(e) = env.add_template_owned(format!("{name}.html"), actual) {
                    failures.push(format!("{name}: minijinja rejects the output: {e}"));
                }
            }
            Ok(actual) => failures.push(format!(
                "{name}: output differs\n--- expected\n{expected}\n--- actual\n{actual}"
            )),
            Err(diags) => failures.push(format!("{name}: unexpected diagnostics {diags:?}")),
        }
        checked += 1;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    assert!(
        checked >= 15,
        "expected at least 15 fixtures, found {checked}"
    );
}

#[test]
fn fixtures_cover_every_syntax_row_of_the_f0_subset() {
    // One fixture per row of the "In" list in issue #9.
    for name in [
        "interpolation",    // {{ expr }} passes through
        "raw-script-style", // left literal inside <script>/<style>
        "if-chain",         // r-if / r-else-if / r-else
        "for-simple",       // r-for="p in items"
        "for-index",        // r-for="(p, i) in items"
        "for-empty",        // r-empty
        "bind-attr",        // :attr="expr"
        "class-object",     // :class object, merged with static class
        "boolean-attr",     // :disabled and other boolean attributes
        "fragment",         // r-fragment -> block, fragment map
        "layout",           // <r-layout use>
        "group",            // <r-group>
        "r-html",           // r-html -> | safe
        "passthrough",      // hx-*, x-*, others unchanged, order kept
        "static-merge",     // consecutive static text is one chunk
    ] {
        assert!(
            common::fixtures().join(format!("{name}.html")).exists(),
            "missing fixture {name}"
        );
    }
}

#[test]
fn fragment_map_is_collected_in_document_order() {
    let out = template_proto::compile(&common::read("fragment.html")).unwrap();
    assert_eq!(
        out.fragments,
        vec![
            ("product_list".into(), "product_list".into()),
            ("cart_summary".into(), "cart_summary".into())
        ]
    );
}

#[test]
fn directives_are_removed_and_passthrough_order_is_kept() {
    let out = template_proto::transpile(&common::read("passthrough.html")).unwrap();
    let div = out.lines().next().unwrap();
    let order = [
        "id=",
        "x-data=",
        "hx-get=",
        "hx-trigger=",
        "hx-target=",
        "@click=",
        "data-a=",
        "aria-label=",
    ];
    let positions: Vec<usize> = order
        .iter()
        .map(|a| div.find(a).unwrap_or_else(|| panic!("{a} missing")))
        .collect();
    assert!(
        positions.windows(2).all(|w| w[0] < w[1]),
        "attribute order changed: {div}"
    );
    let shop = template_proto::transpile(&common::read("shop-products.html")).unwrap();
    assert!(
        !shop.contains(" r-") && !shop.contains(" :"),
        "directive left in output"
    );
}
