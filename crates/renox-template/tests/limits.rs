//! Every render limit has a test (`docs/08-template-engine.md`,
//! "Optimizations and limits"; AGENTS.md: "every per-tenant limit has a
//! test proving it works"). No V8.

mod common;

use std::time::{Duration, Instant};

use common::{compile_files, compile_fixture};
use minijinja::Value;
use renox_template::{RenderContext, RenderError, RenderLimits, RenderTarget, Renderer};
use serde_json::json;

fn value(v: serde_json::Value) -> Value {
    serde_json::from_value(v).unwrap()
}

fn nested_loops_data(n: usize) -> Value {
    let list: Vec<usize> = (0..n).collect();
    value(json!({ "rows": list, "cols": list }))
}

/// B13 (`docs/14-benchmarks.md`) and the threat-model row "Template DoS"
/// (`docs/24-threat-model.md`; `docs/04-isolation-security.md`: "Nested
/// 10k×10k loop → stops at fuel"): the nested-loop fixture stops at fuel
/// within 50 ms, and the renderer keeps serving afterwards.
#[test]
fn b13_nested_loops_stop_at_fuel_within_50_ms() {
    let c = compile_fixture("evil-nested-loops").unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let data = nested_loops_data(10_000);
    let started = Instant::now();
    let err = r
        .render(
            RenderTarget::Page("pages/index"),
            data,
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
        )
        .unwrap_err();
    let elapsed = started.elapsed();
    let RenderError::Fuel(stats) = err else {
        panic!("expected Fuel, got {err:?}");
    };
    assert_eq!(stats.fuel_used, RenderLimits::DEFAULT.fuel);
    assert!(stats.ms > 0.0);
    assert!(
        elapsed < Duration::from_millis(50),
        "B13 stopped after {elapsed:?}"
    );
    eprintln!(
        "B13: stopped at fuel after {elapsed:?} ({:.2} ms CPU)",
        stats.ms
    );
    // Node unaffected: the same renderer renders a small input right after.
    let ok = r
        .render(
            RenderTarget::Page("pages/index"),
            nested_loops_data(3),
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
        )
        .unwrap();
    assert_eq!(ok.html.matches("<td").count(), 9);
}

/// Iteration limit: a list longer than the limit is refused at the loop
/// start, before any item runs.
#[test]
fn iteration_limit() {
    let c = compile_files(&[("pages/index.html", "<p r-for=\"x in xs\">{{ x }}</p>")]).unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let limits = RenderLimits {
        max_iterations: 1_000,
        ..RenderLimits::DEFAULT
    };
    let xs: Vec<u32> = (0..1_001).collect();
    let e = r
        .render(
            RenderTarget::Page("pages/index"),
            value(json!({ "xs": xs })),
            &RenderContext::default(),
            &limits,
        )
        .unwrap_err();
    assert!(matches!(e, RenderError::Iterations(_)), "{e:?}");
    assert!(e.is_limit());
    // Nested loops count all iterations together.
    let c = compile_fixture("evil-nested-loops").unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let e = r
        .render(
            RenderTarget::Page("pages/index"),
            nested_loops_data(40),
            &RenderContext::default(),
            &limits,
        )
        .unwrap_err();
    assert!(matches!(e, RenderError::Iterations(_)), "{e:?}");
    let xs: Vec<u32> = (0..1_000).collect();
    let r2 = Renderer::new(
        compile_files(&[("pages/index.html", "<p r-for=\"x in xs\">{{ x }}</p>")])
            .unwrap()
            .sources(),
    )
    .unwrap();
    assert!(
        r2.render(
            RenderTarget::Page("pages/index"),
            value(json!({ "xs": xs })),
            &RenderContext::default(),
            &limits
        )
        .is_ok()
    );
}

/// Output size limit: output past the limit stops the render.
#[test]
fn output_size_limit() {
    let c = compile_fixture("evil-nested-loops").unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let limits = RenderLimits {
        max_output_bytes: 1024,
        ..RenderLimits::DEFAULT
    };
    let e = r
        .render(
            RenderTarget::Page("pages/index"),
            nested_loops_data(100),
            &RenderContext::default(),
            &limits,
        )
        .unwrap_err();
    let RenderError::OutputSize(stats) = e else {
        panic!("expected OutputSize, got {e:?}");
    };
    assert!(stats.fuel_used > 0, "fuel seen at the last loop start");
    // Fragments are capped too.
    let shop = compile_fixture("shop").unwrap();
    let r = Renderer::new(shop.sources()).unwrap();
    let products: Vec<serde_json::Value> = (0..50)
        .map(|i| json!({"id": i, "name": "x", "slug": "x", "price": 1, "stock": 1}))
        .collect();
    let e = r
        .render(
            RenderTarget::Fragment {
                template: "pages/products/index",
                block: "product_list",
            },
            value(json!({ "products": products })),
            &RenderContext::default(),
            &limits,
        )
        .unwrap_err();
    assert!(matches!(e, RenderError::OutputSize(_)), "{e:?}");
}

/// Include depth: a page with a layout is depth 1; an include cycle is
/// infinitely deep and refused before rendering.
#[test]
fn include_depth_limit() {
    let c = compile_fixture("layout").unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    assert_eq!(r.depth("pages/index"), Some(1));
    let limits = RenderLimits {
        max_depth: 0,
        ..RenderLimits::DEFAULT
    };
    let e = r
        .render(
            RenderTarget::Page("pages/index"),
            value(json!({})),
            &RenderContext::default(),
            &limits,
        )
        .unwrap_err();
    assert!(matches!(e, RenderError::Depth(_)), "{e:?}");

    let cyclic = Renderer::new([
        ("partials/a", "{% include \"partials/b\" %}"),
        ("partials/b", "{% include \"partials/a\" %}"),
    ])
    .unwrap();
    assert_eq!(cyclic.depth("partials/a"), Some(usize::MAX));
    let e = cyclic
        .render(
            RenderTarget::Page("partials/a"),
            value(json!({})),
            &RenderContext::default(),
            &RenderLimits::DEFAULT,
        )
        .unwrap_err();
    assert!(matches!(e, RenderError::Depth(_)), "{e:?}");
}

/// Render timeout: checked at every write and loop start.
#[test]
fn render_timeout() {
    let c = compile_fixture("evil-nested-loops").unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let limits = RenderLimits {
        fuel: u64::MAX / 4,
        max_iterations: u64::MAX,
        max_output_bytes: usize::MAX,
        timeout: Duration::from_millis(5),
        ..RenderLimits::DEFAULT
    };
    let started = Instant::now();
    let e = r
        .render(
            RenderTarget::Page("pages/index"),
            nested_loops_data(10_000),
            &RenderContext::default(),
            &limits,
        )
        .unwrap_err();
    assert!(matches!(e, RenderError::Timeout(_)), "{e:?}");
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "{:?}",
        started.elapsed()
    );
}

/// The error-page budget of `docs/contracts/errors.md` section 1: a heavy
/// error template stops at its small fuel budget.
#[test]
fn error_page_budget() {
    let c = compile_files(&[(
        "pages/_error.html",
        "<h1>{{ status }}</h1><p r-for=\"x in xs\">{{ x }}</p>",
    )])
    .unwrap();
    let r = Renderer::new(c.sources()).unwrap();
    let ok = r
        .render(
            RenderTarget::Page("pages/_error"),
            value(json!({"status": 500, "code": "RENOX_INTERNAL", "request_id": "r", "message": "m", "xs": []})),
            &RenderContext::default(),
            &RenderLimits::ERROR_PAGE,
        )
        .unwrap();
    assert!(ok.fuel_used < RenderLimits::ERROR_PAGE.fuel);
    // 900 items: under the iteration limit, over the fuel budget.
    let xs: Vec<u32> = (0..900).collect();
    let limits = RenderLimits {
        fuel: 5_000,
        ..RenderLimits::ERROR_PAGE
    };
    let res = r.render(
        RenderTarget::Page("pages/_error"),
        value(json!({"status": 500, "xs": xs})),
        &RenderContext::default(),
        &limits,
    );
    assert!(matches!(res, Err(RenderError::Fuel(_))), "{:?}", res.err());
    let xs: Vec<u32> = (0..5_000).collect();
    let res = r.render(
        RenderTarget::Page("pages/_error"),
        value(json!({"status": 500, "xs": xs})),
        &RenderContext::default(),
        &RenderLimits::ERROR_PAGE,
    );
    assert!(matches!(&res, Err(e) if e.is_limit()), "{:?}", res.err());
}
