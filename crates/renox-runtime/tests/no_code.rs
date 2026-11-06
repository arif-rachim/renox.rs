//! Artifact 1.6, "An app with no code": a deployment whose `code.entry` is
//! empty starts no V8 thread; its `.html` pages are still answered.
#![cfg(feature = "v8")]

mod support;

use std::sync::atomic::Ordering;

use renox_runtime::limits::Limits;
use renox_runtime::{Runtime, RuntimeConfig};
use support::*;

fn no_code_artifact() -> (std::path::PathBuf, String) {
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "x", "timezone": "UTC" },
        "code": { "format": "esm-dir", "entry": {} },
        "routes": [
            { "kind": "page", "path": "/", "template": "pages/index" },
            { "kind": "page", "path": "/about", "template": "pages/about" }
        ],
        "templates": {
            "pages/index": { "kind": "page", "fragments": {} },
            "pages/about": { "kind": "page", "fragments": {} }
        },
        "permissions": { "network": [], "secrets": [] }
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", manifest.as_slice()),
        ("templates/pages/index.jinja", b"<h1>home</h1>"),
        ("templates/pages/about.jinja", b"<h1>about</h1>"),
    ])
}

#[tokio::test]
async fn a_code_less_deployment_starts_no_isolate_and_serves_its_pages() {
    let rt = Runtime::new(RuntimeConfig::default());
    let (dir, hash) = no_code_artifact();
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    assert!(iso.is_codeless());
    assert_eq!(iso.pool_size(), 0);
    assert!(iso.stats().is_none());
    assert_eq!(rt.metrics().isolates_created.load(Ordering::Relaxed), 0);

    let home = iso.dispatch(ctx("req_nocode_home_1"), get("/")).await;
    assert!(home.page);
    let render = home.render.expect("page render");
    assert_eq!(render.data_json, "{}");
    assert_eq!(render.template.as_deref(), Some("pages/index"));

    let missing = iso.dispatch(ctx("req_nocode_nope_01"), get("/nope")).await;
    assert_eq!(missing.response.status(), 404);

    assert_eq!(iso.pool_size(), 0);
    assert_eq!(rt.metrics().isolates_created.load(Ordering::Relaxed), 0);
    iso.terminate();
}
