//! The neutral suspension page (#325, #123; `artifact.md` 1.5 section 5,
//! "Suspended"). `docs/23-failure-modes.md`, "Abuse: CPU and egress quota
//! breach", and `docs/24-threat-model.md`, "Abuse of the platform": a
//! suspended tenant's hostname runs no tenant code and shows only its name.

mod common;

use std::sync::Arc;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode, header};
use common::*;
use renox_gateway::{Gateway, GatewayConfig, RouteEntry, RouteStatus, RouteTable};
use tower::ServiceExt;

fn suspended(host: &str, hash: &str, name: &str) -> RouteEntry {
    RouteEntry {
        display_name: Some(name.into()),
        ..entry(host, "t_a", hash, RouteStatus::Suspended)
    }
}

async fn body_string(resp: axum::http::Response<Body>) -> String {
    String::from_utf8(to_bytes(resp.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap()
}

fn html(host: &str, path: &str) -> Request<Body> {
    let mut r = request(host, path);
    r.headers_mut()
        .insert(header::ACCEPT, "text/html".parse().unwrap());
    r
}

#[tokio::test]
async fn a_suspended_host_answers_503_with_the_neutral_page_and_touches_no_cell() {
    let dir = tempfile::tempdir().unwrap();
    // A static file of the deployment must not be served either.
    write_public(
        dir.path(),
        HASH_A,
        &[("index.html", b"tenant content", "text/html")],
    );
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(suspended("a.test", HASH_A, "Gulf <Shop>"))
        .unwrap();
    let gw = Gateway::new(GatewayConfig::new(dir.path()), routes);
    let cell = FakeDispatcher::new();
    let app = gw.router(cell.clone());

    let resp = app.clone().oneshot(html("a.test", "/")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(resp.headers()[header::RETRY_AFTER], "3600");
    let page = body_string(resp).await;
    assert!(page.contains("Gulf &lt;Shop&gt;"), "{page}");
    assert!(page.contains("This service is temporarily unavailable."));
    assert!(!page.contains("tenant content"));

    let resp = app.oneshot(request("a.test", "/api/x")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = body_string(resp).await;
    assert!(body.contains("\"RENOX_TENANT_SUSPENDED\""), "{body}");
    assert!(!body.contains("Gulf"));
    assert_eq!(cell.count(), 0);
}

#[tokio::test]
async fn suspension_drains_the_active_entry_and_reinstating_ends_it() {
    let dir = tempfile::tempdir().unwrap();
    let routes = Arc::new(RouteTable::new());
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    routes.upsert(suspended("a.test", HASH_A, "Shop")).unwrap();
    assert!(routes.lookup("a.test").is_none());
    assert!(routes.suspended("a.test").is_some());

    // Reinstated: the active entry replaces the suspension.
    routes
        .upsert(entry("a.test", "t_a", HASH_A, RouteStatus::Active))
        .unwrap();
    assert!(routes.suspended("a.test").is_none());
    let gw = Gateway::new(GatewayConfig::new(dir.path()), routes);
    let cell = FakeDispatcher::new();
    let resp = gw
        .router(cell.clone())
        .oneshot(request("a.test", "/"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(cell.count(), 1);
}

#[test]
fn v13_refuses_suspended_and_active_on_one_host_and_a_display_name_elsewhere() {
    let t = RouteTable::new();
    let both = vec![
        entry("a.test", "t_a", HASH_A, RouteStatus::Active),
        suspended("a.test", HASH_B, "Shop"),
    ];
    assert!(
        t.replace(both)
            .unwrap_err()
            .to_string()
            .contains("both suspended and active")
    );
    let named = RouteEntry {
        display_name: Some("Shop".into()),
        ..entry("a.test", "t_a", HASH_A, RouteStatus::Active)
    };
    assert!(
        t.upsert(named)
            .unwrap_err()
            .to_string()
            .contains("display_name")
    );
    // The control plane's wire form parses.
    let json = format!(
        r#"{{"version":0,"entries":[{{"hostname":"a.test","tenant_id":"t_a","deployment_hash":"{HASH_A}","status":"suspended","updated_at":1,"display_name":"Shop"}}]}}"#
    );
    let t = RouteTable::from_json(&json).unwrap();
    assert_eq!(
        t.suspended("a.test").unwrap().display_name.as_deref(),
        Some("Shop")
    );
}
