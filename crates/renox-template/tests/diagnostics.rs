//! Compile pipeline step 3 (`docs/08-template-engine.md`): every validation
//! rule reports the file, line, and column. Also the DSL rule of AGENTS.md
//! ("Templates are a DSL with no code execution"): calls and reserved names
//! are rejected at compile time.

mod common;

use std::collections::BTreeSet;

use common::{compile_files, compile_with};
use renox_template::{CompileOptions, Diagnostic};

fn errors(files: &[(&str, &str)]) -> Vec<Diagnostic> {
    compile_files(files).expect_err("expected diagnostics")
}

/// Asserts one diagnostic at `file:line:col` whose message contains `needle`.
fn expect(diags: &[Diagnostic], file: &str, line: usize, col: usize, needle: &str) {
    assert!(
        diags.iter().any(|d| d.file == file
            && d.line == line
            && d.col == col
            && d.message.contains(needle)),
        "no `{needle}` at {file}:{line}:{col} in:\n{}",
        common::show(diags)
    );
}

fn page(src: &str) -> Vec<Diagnostic> {
    errors(&[("pages/index.html", src)])
}

#[test]
fn else_without_if() {
    let d = page("<div>\n  <p r-else>x</p>\n  <p r-else-if=\"a\">y</p>\n</div>");
    expect(&d, "pages/index.html", 2, 6, "`r-else` must follow");
    expect(&d, "pages/index.html", 3, 6, "`r-else-if` must follow");
}

#[test]
fn empty_without_for_or_other_list() {
    let d = page("<ul><li r-empty=\"items\">none</li></ul>");
    expect(&d, "pages/index.html", 1, 9, "`r-empty` must follow");
    let d = page("<ul><li r-for=\"p in items\">{{ p }}</li><li r-empty=\"other\">none</li></ul>");
    expect(
        &d,
        "pages/index.html",
        1,
        44,
        "does not match the loop's list",
    );
}

#[test]
fn invalid_expressions() {
    let d = page("<p r-if=\"a ==\">x</p>\n<p>{{ b + }}</p>\n<a :href=\"'unterminated\">l</a>");
    expect(&d, "pages/index.html", 1, 4, "invalid expression");
    expect(&d, "pages/index.html", 2, 4, "invalid expression");
    expect(&d, "pages/index.html", 3, 4, "unterminated string");
}

#[test]
fn bad_for_and_if_with_for() {
    let d = page("<li r-for=\"p of items\">x</li>\n<li r-for=\"p in items\" r-if=\"p\">x</li>");
    expect(&d, "pages/index.html", 1, 5, "r-for must be");
    expect(
        &d,
        "pages/index.html",
        2,
        24,
        "wrap the element in `<r-group",
    );
}

#[test]
fn unknown_directive_and_element() {
    let d = page("<p r-show=\"x\">a</p>\n<r-foo></r-foo>");
    expect(&d, "pages/index.html", 1, 4, "unknown directive `r-show`");
    expect(&d, "pages/index.html", 2, 1, "unknown element `<r-foo>`");
}

/// AGENTS.md: "Do not add free function calls to the expression language."
#[test]
fn function_calls_and_reserved_names_are_refused() {
    let d = page(
        "<p>{{ range(10) }}</p>\n<p r-if=\"user.items()\">x</p>\n<p>{{ __renox.csp_nonce }}</p>\n<p>{{ x | safe }}</p>\n<p>{% for x in y %}{% endfor %}</p>",
    );
    expect(
        &d,
        "pages/index.html",
        1,
        4,
        "function calls are not allowed",
    );
    expect(&d, "pages/index.html", 2, 4, "method calls are not allowed");
    expect(&d, "pages/index.html", 3, 4, "reserved for the platform");
    expect(&d, "pages/index.html", 4, 4, "unknown filter `safe`");
    expect(&d, "pages/index.html", 5, 4, "template statements");
}

#[test]
fn unknown_fragment_names_and_duplicates() {
    let d = page(
        "<div r-fragment=\"BadName\">a</div>\n<div id=\"x\" r-fragment=\"f\">b</div>\n<div id=\"x\" r-fragment=\"f\">c</div>\n<ul><li r-for=\"p in ps\"><b r-fragment=\"inner\">{{ p }}</b></li></ul>",
    );
    expect(&d, "pages/index.html", 1, 6, "must match");
    expect(&d, "pages/index.html", 3, 13, "already exists");
    expect(
        &d,
        "pages/index.html",
        4,
        28,
        "inside an `r-for` loop or a component",
    );
}

#[test]
fn duplicate_fragment_targets() {
    let d = page("<div id=\"t\" r-fragment=\"a\">a</div>\n<div id=\"t\" r-fragment=\"b\">b</div>");
    expect(&d, "pages/index.html", 2, 6, "same id `t`");
}

#[test]
fn unknown_components_and_bad_props() {
    let card = "<r-props product=\"Product\" compact=\"bool = false\" count=\"number = 1\" />\n<b>{{ product.name }}</b>";
    let d = errors(&[
        ("partials/card.html", card),
        (
            "pages/index.html",
            "<x-nope></x-nope>\n<x-card></x-card>\n<x-card :product=\"p\" colour=\"red\" compact=\"maybe\" count=\"many\"></x-card>",
        ),
    ]);
    expect(&d, "pages/index.html", 1, 1, "unknown component `<x-nope>`");
    expect(&d, "pages/index.html", 2, 1, "needs the prop `product`");
    expect(&d, "pages/index.html", 3, 22, "has no prop `colour`");
    expect(&d, "pages/index.html", 3, 35, "is not a boolean");
    expect(&d, "pages/index.html", 3, 51, "is not a number");
}

#[test]
fn component_reads_only_its_props_and_slots_must_exist() {
    let d = errors(&[
        (
            "partials/card.html",
            "<r-props title=\"string\" />\n<h3>{{ title }} {{ secret }}</h3><slot name=\"footer\" />",
        ),
        (
            "pages/index.html",
            "<x-card title=\"a\">\n  <p slot=\"header\">h</p>\n  <p>body</p>\n</x-card>",
        ),
    ]);
    expect(
        &d,
        "partials/card.html",
        1,
        1,
        "uses `secret`, which is not a prop",
    );
    expect(&d, "pages/index.html", 2, 6, "has no slot `header`");
    expect(&d, "pages/index.html", 1, 1, "has no default `<slot />`");
}

#[test]
fn component_recursion() {
    let d = errors(&[
        ("partials/a.html", "<x-b></x-b>"),
        ("partials/b.html", "<x-a></x-a>"),
        ("pages/index.html", "<x-a></x-a>"),
    ]);
    assert!(
        d.iter().any(|d| d.message.contains("includes itself")),
        "{}",
        common::show(&d)
    );
}

#[test]
fn layouts_unknown_and_unknown_slots() {
    let layout = "<!doctype html><html><body><main><slot /></main></body></html>";
    let d = errors(&[
        ("pages/_layouts/main.html", layout),
        ("pages/a.html", "<r-layout use=\"nope\"><p>x</p></r-layout>"),
        (
            "pages/b.html",
            "<r-layout use=\"main\">\n  <p slot=\"sidebar\">x</p>\n</r-layout>",
        ),
        (
            "pages/c.html",
            "<div><r-layout use=\"main\"></r-layout></div>",
        ),
    ]);
    expect(&d, "pages/a.html", 1, 11, "unknown layout `nope`");
    expect(&d, "pages/b.html", 2, 6, "has no slot `sidebar`");
    expect(&d, "pages/c.html", 1, 6, "only top-level element");
}

#[test]
fn unknown_actions_in_r_can() {
    let options = CompileOptions {
        actions: Some(BTreeSet::from(["cart.add".to_string()])),
        ..CompileOptions::default()
    };
    let d = compile_with(
        &[("pages/index.html", "<b r-can=\"cart.add\">ok</b>\n<b r-can=\"cart.delete\">no</b>\n<b r-can=\"not an action\">x</b>")],
        options,
    )
    .unwrap_err();
    expect(&d, "pages/index.html", 2, 4, "unknown action `cart.delete`");
    expect(&d, "pages/index.html", 3, 4, "needs an action name");
    assert_eq!(d.len(), 2, "{}", common::show(&d));
}

#[test]
fn file_level_rules() {
    let d = errors(&[
        ("pages/_partial.html", "<p>x</p>"),
        ("overrides/billing/partials/x.html", "<p>x</p>"),
        ("lib/x.html", "<p>x</p>"),
    ]);
    expect(&d, "pages/_partial.html", 1, 1, "are not routes");
    expect(
        &d,
        "overrides/billing/partials/x.html",
        1,
        1,
        "does not exist",
    );
    expect(&d, "lib/x.html", 1, 1, "not a template path");
}

#[test]
fn nonce_and_bound_event_handlers_are_refused() {
    let d = page("<script nonce=\"abc\">x</script>\n<button :onclick=\"x\">b</button>");
    expect(&d, "pages/index.html", 1, 9, "set by the platform");
    expect(&d, "pages/index.html", 2, 9, "event handler");
}

#[test]
fn diagnostics_are_sorted_and_display_file_line_col() {
    let d = page("<p r-else>x</p>\n<p r-foo>y</p>");
    assert_eq!(
        d[0].to_string(),
        "pages/index.html:1:4: `r-else` must follow a sibling with `r-if` or `r-else-if`"
    );
    assert!(
        d.windows(2)
            .all(|w| (w[0].line, w[0].col) <= (w[1].line, w[1].col))
    );
}
