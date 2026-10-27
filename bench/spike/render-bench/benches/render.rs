//! B6 first cut (issue #11): criterion benchmark of the render stage.
//!
//! - `page/100`: full page, 100 products (the B6 page, about 25 KB).
//! - `fragment/100`: the `product_list` block compiled as its own template.
//! - `fragment_captured/100`: the same block via minijinja's captured state:
//!   the page is evaluated into a sink, then the block is rendered. This is
//!   what minijinja 3 offers without a separate template.
//! - `page/1000`: full page, 1,000 products, for scaling.
//! - `page_fuel/100`: full page with fuel tracking on (F2 DoS limit).
//!
//! Products are built as `minijinja::Value` once, outside the measurement.
//! With `B6_META_OUT` set, writes page sizes and fuel consumed there as JSON.

use std::hint::black_box;

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use minijinja::{Value, context};
use render_bench::{FRAGMENT, FRAGMENT_BLOCK, FUEL_BUDGET, PAGE, env, page_context, products};

fn write_meta() {
    let Ok(path) = std::env::var("B6_META_OUT") else {
        return;
    };
    let page_100 = env(None)
        .get_template(PAGE)
        .unwrap()
        .render(page_context(100))
        .unwrap();
    let page_1000 = env(None)
        .get_template(PAGE)
        .unwrap()
        .render(page_context(1000))
        .unwrap();
    let fragment = env(None)
        .get_template(FRAGMENT)
        .unwrap()
        .render(context! { products => products(100) })
        .unwrap();
    let fuel_env = env(Some(FUEL_BUDGET));
    let tmpl = fuel_env.get_template(PAGE).unwrap();
    let captured = tmpl.render_captured(page_context(100)).unwrap();
    let (fuel, _) = captured.state().fuel_levels().unwrap();
    assert_eq!(captured.output(), page_100, "fuel changed the output");
    let json = format!(
        "{{\"page_100_bytes\":{},\"page_1000_bytes\":{},\"fragment_100_bytes\":{},\"page_100_fuel\":{fuel}}}\n",
        page_100.len(),
        page_1000.len(),
        fragment.len()
    );
    std::fs::write(path, json).unwrap();
}

fn render(c: &mut Criterion) {
    write_meta();
    let plain = env(None);
    let fuelled = env(Some(FUEL_BUDGET));
    let page = plain.get_template(PAGE).unwrap();
    let fragment = plain.get_template(FRAGMENT).unwrap();
    let page_fuel = fuelled.get_template(PAGE).unwrap();

    let ctx_100 = page_context(100);
    let ctx_1000 = page_context(1000);
    let fragment_ctx: Value = context! { products => products(100) };

    let html = page.render(&ctx_100).unwrap();
    let kb = html.len() as f64 / 1024.0;
    assert!((20.0..=30.0).contains(&kb), "full page is {kb:.1} KB");

    let mut group = c.benchmark_group("B6");
    group.bench_function(BenchmarkId::new("page", 100), |b| {
        b.iter(|| black_box(page.render(black_box(&ctx_100)).unwrap()))
    });
    group.bench_function(BenchmarkId::new("fragment", 100), |b| {
        b.iter(|| black_box(fragment.render(black_box(&fragment_ctx)).unwrap()))
    });
    group.bench_function(BenchmarkId::new("fragment_captured", 100), |b| {
        b.iter(|| {
            let mut captured = page
                .render_captured_to(black_box(&fragment_ctx), std::io::sink())
                .unwrap();
            black_box(
                captured
                    .with_state_mut(|state| state.render_block(FRAGMENT_BLOCK))
                    .unwrap(),
            )
        })
    });
    group.bench_function(BenchmarkId::new("page", 1000), |b| {
        b.iter(|| black_box(page.render(black_box(&ctx_1000)).unwrap()))
    });
    group.bench_function(BenchmarkId::new("page_fuel", 100), |b| {
        b.iter(|| black_box(page_fuel.render(black_box(&ctx_100)).unwrap()))
    });
    group.finish();
}

criterion_group!(benches, render);
criterion_main!(benches);
