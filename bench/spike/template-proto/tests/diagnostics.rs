//! Compile errors carry the line and column of the offending attribute
//! (docs/08-template-engine.md, "Compile pipeline", step 3).

use template_proto::{Diagnostic, transpile};

fn errors(html: &str) -> Vec<Diagnostic> {
    transpile(html).expect_err("expected diagnostics")
}

#[test]
fn r_else_without_r_if() {
    let d = errors("<div>\n  <p>a</p>\n  <span r-else>b</span>\n</div>");
    assert_eq!(d.len(), 1);
    assert_eq!((d[0].line, d[0].col), (3, 9));
    assert!(
        d[0].message.contains("`r-else` must follow"),
        "{}",
        d[0].message
    );
}

#[test]
fn r_else_if_without_r_if() {
    let d = errors("<p r-else-if=\"x\">a</p>");
    assert_eq!((d[0].line, d[0].col), (1, 4));
}

#[test]
fn r_else_after_a_non_conditional_sibling_is_rejected() {
    // A plain element between r-if and r-else breaks the chain.
    let d = errors("<b r-if=\"a\">1</b><i>2</i><u r-else>3</u>");
    assert_eq!(d.len(), 1);
    assert_eq!((d[0].line, d[0].col), (1, 29));
}

#[test]
fn unknown_directive() {
    let d = errors("<ul>\n  <li r-repeat=\"x in xs\">a</li>\n</ul>");
    assert_eq!((d[0].line, d[0].col), (2, 7));
    assert!(d[0].message.contains("unknown directive `r-repeat`"));
}

#[test]
fn deferred_directive_is_reported_as_such() {
    let d = errors("<button r-can=\"cart.add\">Add</button>");
    assert!(d[0].message.contains("deferred to F2"), "{}", d[0].message);
}

#[test]
fn r_empty_without_r_for() {
    let d = errors("<li r-empty=\"items\">none</li>");
    assert!(d[0].message.contains("`r-empty` must follow"));
}

#[test]
fn r_empty_must_name_the_loop_list() {
    let d = errors("<li r-for=\"p in products\">a</li><li r-empty=\"orders\">none</li>");
    assert!(d[0].message.contains("does not match"), "{}", d[0].message);
}

#[test]
fn invalid_expression_points_at_the_attribute() {
    let d = errors("<p>\n<b :title=\"a ==\">x</b></p>");
    assert_eq!((d[0].line, d[0].col), (2, 4));
    assert!(d[0].message.contains("invalid expression in `:title`"));
}

#[test]
fn bad_r_for() {
    let d = errors("<li r-for=\"p of items\">a</li>");
    assert!(d[0].message.contains("r-for must be"));
}

#[test]
fn r_if_and_r_for_on_one_element() {
    let d = errors("<li r-for=\"p in ps\" r-if=\"p.ok\">a</li>");
    assert!(d[0].message.contains("<r-group"), "{}", d[0].message);
}

#[test]
fn duplicate_fragment() {
    let d = errors("<div r-fragment=\"a\">1</div><div r-fragment=\"a\">2</div>");
    assert!(d[0].message.contains("defined twice"));
}

#[test]
fn components_are_deferred() {
    let d = errors("<x-product-card :product=\"p\"></x-product-card>");
    assert!(d[0].message.contains("components are not supported"));
}

#[test]
fn multiple_errors_are_all_reported_in_order() {
    let d = errors("<a r-else>1</a>\n<b r-nope>2</b>\n<c r-if=\"(\">3</c>");
    let lines: Vec<usize> = d.iter().map(|d| d.line).collect();
    assert_eq!(lines, vec![1, 2, 3]);
}

#[test]
fn diagnostic_display_has_line_and_column() {
    let d = errors("<p r-else>a</p>");
    assert_eq!(
        d[0].to_string(),
        "1:4: `r-else` must follow a sibling with `r-if` or `r-else-if`"
    );
}
