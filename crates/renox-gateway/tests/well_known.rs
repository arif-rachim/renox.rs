//! #121: `/.well-known/security.txt` for the platform's own hosts
//! (`docs/24-threat-model.md` "Security process" item 5). Served by the
//! gateway, valid under RFC 9116, whether or not the host is routed; a
//! tenant host's own path reaches the tenant. #364: the defaults name
//! `security@renoxium.com` on the platform domain's apex `renoxium.app`, and
//! `worker.toml` `[gateway.security_txt]` replaces them.

mod common;

use std::sync::Arc;
use std::time::SystemTime;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::*;
use renox_gateway::well_known::{SECURITY_TXT_PATH, SecurityTxt, Settings, validate};
use renox_gateway::{Gateway, GatewayConfig, RouteStatus, RouteTable};
use tower::ServiceExt;

fn gateway(root: &std::path::Path, txt: Option<SecurityTxt>) -> Gateway {
    let table = RouteTable::new();
    table
        .upsert(entry(
            "www.example.test",
            "t_site",
            HASH_A,
            RouteStatus::Active,
        ))
        .unwrap();
    table
        .upsert(entry(
            "shop.renoxium.app",
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

    // `renoxium.app`, the apex of the platform domain, has no route entry; it
    // serves the platform's file without reaching a cell.
    for host in ["renoxium.app"] {
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
        assert!(text.contains("Contact: mailto:security@renoxium.com\n"));
        assert!(text.contains("Canonical: https://renoxium.app/.well-known/security.txt\n"));
    }
    assert_eq!(cells.count(), 0);

    // A tenant host's own `/.well-known/security.txt` is the tenant's.
    let resp = app
        .clone()
        .oneshot(request("shop.renoxium.app", SECURITY_TXT_PATH))
        .await
        .unwrap();
    assert_eq!(body(resp).await, "tenant=t_shop");

    // Only GET and HEAD.
    let post = Request::builder()
        .method("POST")
        .uri(SECURITY_TXT_PATH)
        .header("host", "renoxium.app")
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
        .oneshot(request("renoxium.app", SECURITY_TXT_PATH))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND, "an unknown host");
}

/// #364: an operator's `[gateway.security_txt]` replaces the hosts, the
/// contacts and the canonical URL; a routed host listed there serves the
/// platform's file, not the tenant's, and the default host no longer does.
#[tokio::test]
async fn configured_settings_replace_the_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let cells = FakeDispatcher::new();
    let txt = Settings {
        hosts: vec!["www.example.test".into()],
        contacts: vec!["mailto:sec@example.test".into()],
        canonical: None,
        policy: None,
    }
    .build(SystemTime::now())
    .unwrap();
    let app = gateway(dir.path(), Some(txt)).router(cells.clone());
    let resp = app
        .clone()
        .oneshot(request("www.example.test", SECURITY_TXT_PATH))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let text = body(resp).await;
    validate(&text, SystemTime::now()).unwrap();
    assert!(text.contains("Contact: mailto:sec@example.test\n"));
    assert!(text.contains("Canonical: https://www.example.test/.well-known/security.txt\n"));
    assert!(!text.contains("renoxium.com"));
    assert_eq!(cells.count(), 0);
    let resp = app
        .oneshot(request("renoxium.app", SECURITY_TXT_PATH))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
