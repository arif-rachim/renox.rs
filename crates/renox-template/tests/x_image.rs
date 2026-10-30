//! `<x-image>` (`docs/08-template-engine.md`, "Built-in components";
//! `docs/contracts/ops.md` 1.7.0 section 21; #321): the `<img>` the
//! compiler emits, with the URLs of the image pipeline and the dimensions
//! of the stored file. No V8.

mod common;

use common::{compile_files, show};
use minijinja::Value;
use renox_template::{RenderContext, RenderLimits, RenderTarget, Renderer};
use serde_json::json;

fn render(src: &str, data: serde_json::Value, ctx: &RenderContext) -> String {
    let c = compile_files(&[("pages/p.html", src)]).unwrap_or_else(|d| panic!("{}", show(&d)));
    let r = Renderer::new(c.sources()).expect("renderer builds");
    r.render(
        RenderTarget::Page("pages/p"),
        serde_json::from_value::<Value>(data).unwrap(),
        ctx,
        &RenderLimits::DEFAULT,
    )
    .unwrap_or_else(|e| panic!("{e:?}"))
    .html
}

fn photo() -> serde_json::Value {
    json!({ "photo": { "key": "app/products/p1.jpg", "width": 4000, "height": 3000, "content_type": "image/jpeg", "public": true } })
}

#[test]
fn the_tag_is_an_img_with_srcset_dimensions_lazy_loading_and_the_options() {
    let html = render(
        r#"<x-image :src="photo" width="400" alt="Red chair" fit="cover" sizes="(min-width: 600px) 400px, 100vw" class="thumb"></x-image>"#,
        photo(),
        &RenderContext::default(),
    );
    assert!(
        html.starts_with("<img src=\"/_img/app/products/p1.jpg?w=400&amp;fit=cover\""),
        "{html}"
    );
    assert!(html.contains("srcset=\"/_img/app/products/p1.jpg?w=400&amp;fit=cover 1x, /_img/app/products/p1.jpg?w=800&amp;fit=cover 2x\""), "{html}");
    assert!(
        html.contains(" width=\"400\" height=\"300\""),
        "the height from the stored ratio: {html}"
    );
    assert!(html.contains(" alt=\"Red chair\""), "{html}");
    assert!(
        html.contains(" sizes=\"(min-width: 600px) 400px, 100vw\""),
        "{html}"
    );
    assert!(html.contains(" class=\"thumb\""), "{html}");
    assert!(
        html.ends_with(" loading=\"lazy\" decoding=\"async\">"),
        "{html}"
    );
    assert!(!html.contains("x-image"), "{html}");
}

#[test]
fn without_width_the_stored_width_and_a_signed_private_file_carries_its_signature() {
    let html = render(
        r#"<x-image :src="doc" :alt="doc.key" placeholder="blur"></x-image>"#,
        json!({ "doc": { "key": "app/private/scan.png", "width": 640, "height": 480, "public": false, "exp": 1793318400, "sig": "ab12cd" } }),
        &RenderContext::default(),
    );
    assert!(
        html.contains("src=\"/_img/app/private/scan.png?w=640&amp;exp=1793318400&amp;sig=ab12cd\""),
        "{html}"
    );
    assert!(
        html.contains("w=1280&amp;exp=1793318400&amp;sig=ab12cd 2x"),
        "{html}"
    );
    assert!(html.contains(" width=\"640\" height=\"480\""), "{html}");
    assert!(
        html.contains("background-image:url(/_img/app/private/scan.png?w=16"),
        "the blur placeholder: {html}"
    );
    assert!(html.contains(" alt=\"app/private/scan.png\""), "{html}");
}

#[test]
fn rtl_pages_are_unaffected_and_a_missing_file_renders_a_bare_img() {
    let ar = RenderContext {
        lang: Some("ar".into()),
        dir: Some(renox_template::Dir::Rtl),
        ..RenderContext::default()
    };
    let html = render(
        r#"<x-image :src="photo" width="200" alt="كرسي"></x-image>"#,
        photo(),
        &ar,
    );
    assert!(
        html.contains("src=\"/_img/app/products/p1.jpg?w=200\""),
        "{html}"
    );
    assert!(
        !html.contains("dir="),
        "an image gets no direction of its own: {html}"
    );
    let none = render(
        r#"<x-image :src="missing" width="200" alt="x"></x-image>"#,
        json!({}),
        &RenderContext::default(),
    );
    assert_eq!(none, "<img alt=\"x\" loading=\"lazy\" decoding=\"async\">");
    // A key that is not a storage key never reaches the URL.
    let evil = render(
        r#"<x-image :src="f" width="200" alt="x"></x-image>"#,
        json!({ "f": { "key": "javascript:alert(1)\" onerror=\"x", "width": 10, "height": 10 } }),
        &RenderContext::default(),
    );
    assert_eq!(evil, "<img alt=\"x\" loading=\"lazy\" decoding=\"async\">");
}

#[test]
fn bad_options_are_compile_errors() {
    for (src, needle) in [
        (r#"<x-image width="400" alt="x"></x-image>"#, ":src"),
        (
            r#"<x-image :src="p" width="wide" alt="x"></x-image>"#,
            "width",
        ),
        (
            r#"<x-image :src="p" fit="stretch" alt="x"></x-image>"#,
            "fit",
        ),
        (
            r#"<x-image :src="p" placeholder="color" alt="x"></x-image>"#,
            "placeholder",
        ),
    ] {
        let d = compile_files(&[("pages/p.html", src)])
            .err()
            .unwrap_or_else(|| panic!("{src} compiled"));
        assert!(show(&d).contains(needle), "{src}: {}", show(&d));
    }
}
