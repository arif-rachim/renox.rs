//! #121: `/.well-known/security.txt` for the platform's own hosts
//! (`docs/24-threat-model.md` "Security process" item 5). Served by the
//! gateway, valid under RFC 9116, whether or not the host is routed; a
//! tenant host's own path reaches the tenant.

mod common;

use std::sync::Arc;
use std::time::SystemTime;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use renox_gateway::well_known::{SECURITY_TXT_PATH, SecurityTxt, validate};
use renox_gateway::{Gateway, GatewayConfig, RouteStatus, RouteTable};
use tower::ServiceExt;

fn gateway(root: &std::path::Path, txt: Option<SecurityTxt>) -> Gateway {
    let table = RouteTable::new();
    table
        .upsert(entry(
            "www.renox.app",
            "t_site",
            HASH_A,
            RouteStatus::Active,
        ))
        .unwrap();
    table
        .upsert(entry(
            "shop.renox.app",
            "t_shop",
            HASH_B,
            RouteStatus::Active,
        ))
        .unwrap();
    let mut config = GatewayConfig::new(root);
    config.security_txt = txt.map(Arc::new);
    Gateway::new(config, Arc::new(table))
}

async fn body(resp: axum::http::Response<Body>) -> String {
    String::from_utf8(
        axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

#[tokio::test]
async fn platform_hosts_serve_a_valid_security_txt() {
    let dir = tempfile::tempdir().unwrap();
    let cells = FakeDispatcher::new();
    let app =
        gateway(dir.path(), Some(SecurityTxt::platform(SystemTime::now()))).router(cells.clone());

    // `renox.app` has no route entry; `www.renox.app` has one. Both serve
    // the platform's file, without reaching a cell.
    for host in ["renox.app", "www.renox.app"] {
        let resp = app
            .clone()
            .oneshot(request(host, SECURITY_TXT_PATH))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{host}");
        assert_eq!(
            resp.headers()["content-type"],
            "text/plain; charset=utf-8",
            "{host}"
        );
        let text = body(resp).await;
        validate(&text, SystemTime::now()).unwrap_or_else(|e| panic!("{host}: {e}\n{text}"));
        assert!(text.contains("Contact: mailto:security@renox.app"));
    }
    assert_eq!(cells.count(), 0);

    // A tenant host's own `/.well-known/security.txt` is the tenant's.
    let resp = app
        .clone()
        .oneshot(request("shop.renox.app", SECURITY_TXT_PATH))
        .await
        .unwrap();
    assert_eq!(body(resp).await, "tenant=t_shop");

    // Only GET and HEAD.
    let post = Request::builder()
        .method("POST")
        .uri(SECURITY_TXT_PATH)
        .header("host", "renox.app")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(post).await.unwrap();
    assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn without_the_setting_nothing_is_served() {
    let dir = tempfile::tempdir().unwrap();
    let app = gateway(dir.path(), None).router(FakeDispatcher::new());
    let resp = app
        .oneshot(request("renox.app", SECURITY_TXT_PATH))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "an unknown host");
}
