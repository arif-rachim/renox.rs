//! Issue #11 acceptance: the benchmarked renders produce the expected output,
//! and fuel does not change it.

use minijinja::context;
use render_bench::{FRAGMENT, FRAGMENT_BLOCK, FUEL_BUDGET, PAGE, env, page_context, products};

#[test]
fn full_page_is_20_to_30_kb_with_100_cards() {
    let html = env(None)
        .get_template(PAGE)
        .unwrap()
        .render(page_context(100))
        .unwrap();
    let kb = html.len() as f64 / 1024.0;
    assert!((20.0..=30.0).contains(&kb), "full page is {kb:.1} KB");
    assert_eq!(html.matches("<li class=\"card").count(), 100);
    assert!(html.starts_with("<!DOCTYPE html>"));
}

#[test]
fn fragment_template_equals_the_block_rendered_from_the_page() {
    let env = env(None);
    let alone = env
        .get_template(FRAGMENT)
        .unwrap()
        .render(context! { products => products(100) })
        .unwrap();
    let mut captured = env
        .get_template(PAGE)
        .unwrap()
        .render_captured_to(context! { products => products(100) }, std::io::sink())
        .unwrap();
    let from_page = captured
        .with_state_mut(|state| state.render_block(FRAGMENT_BLOCK))
        .unwrap();
    assert_eq!(alone, from_page);
    assert!(alone.starts_with("<ul id=\"product-list\""));
    assert_eq!(alone.matches("<li class=\"card").count(), 100);
    assert!(!alone.contains("<html"));
}

#[test]
fn fuel_does_not_change_the_output_and_is_consumed() {
    let plain = env(None)
        .get_template(PAGE)
        .unwrap()
        .render(page_context(100))
        .unwrap();
    let fuelled_env = env(Some(FUEL_BUDGET));
    let tmpl = fuelled_env.get_template(PAGE).unwrap();
    let captured = tmpl.render_captured(page_context(100)).unwrap();
    let (consumed, _) = captured.state().fuel_levels().expect("fuel enabled");
    assert!(consumed > 0);
    assert_eq!(captured.output(), plain);
}

#[test]
fn a_small_fuel_limit_stops_the_render() {
    let err = env(Some(100))
        .get_template(PAGE)
        .unwrap()
        .render(page_context(100))
        .unwrap_err();
    assert_eq!(err.kind(), minijinja::ErrorKind::OutOfFuel);
}

#[test]
fn thousand_items_render_1000_cards() {
    let html = env(None)
        .get_template(PAGE)
        .unwrap()
        .render(page_context(1000))
        .unwrap();
    assert_eq!(html.matches("<li class=\"card").count(), 1000);
}
