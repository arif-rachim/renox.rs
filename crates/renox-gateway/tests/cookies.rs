//! #207: tenant `Set-Cookie` rewrite at the gateway
//! (`docs/24-threat-model.md` C, "Cookie tossing between tenants"). A tenant
//! cookie scoped to the platform apex, a parent of the request host, or
//! another tenant's host reaches the browser host-only; a malformed one is
//! dropped; the log names the cookie and the removed domain, never the value.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use common::*;
use renox_gateway::{CellDispatcher, Gateway, GatewayConfig, RequestCtx, RouteStatus, RouteTable};
use tower::ServiceExt;

const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

/// A cell whose handler answers with the `Set-Cookie` lines it was given.
struct CookieCell {
    cookies: Vec<&'static [u8]>,
}

impl CellDispatcher for CookieCell {
    async fn dispatch(&self, _ctx: RequestCtx, _req: Request<Body>) -> Response<Body> {
        let mut b = Response::builder().status(StatusCode::OK);
        for c in &self.cookies {
            b = b.header("set-cookie", *c);
        }
        b.body(Body::from("ok")).unwrap()
    }
}

fn gateway(root: &std::path::Path) -> Gateway {
    let table = RouteTable::new();
    table
        .upsert(entry(
            "shop.renox.app",
            "t_shop",
            HASH_A,
            RouteStatus::Active,
        ))
        .unwrap();
    // A custom domain (#59): the request host is the custom hostname.
    table
        .upsert(entry(
            "www.example.com",
            "t_custom",
            HASH_B,
            RouteStatus::Active,
        ))
        .unwrap();
    // Only the log test uses this tenant, so its lines are told apart.
    table
        .upsert(entry(
            "logs.renox.app",
            "t_logs",
            HASH_C,
            RouteStatus::Active,
        ))
        .unwrap();
    Gateway::new(GatewayConfig::new(root), Arc::new(table))
}

async fn set_cookies(host: &str, cookies: Vec<&'static [u8]>) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let app = gateway(dir.path()).router(Arc::new(CookieCell { cookies }));
    let resp = app.oneshot(request(host, "/fn")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    resp.headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .collect()
}

/// Apex, dotted apex, and another tenant's host become host-only; the
/// request host itself is kept; each header is rewritten on its own.
#[tokio::test]
async fn cookies_that_reach_other_tenants_become_host_only() {
    let got = set_cookies(
        "shop.renox.app",
        vec![
            b"a=1; Domain=renox.app; Path=/; Secure",
            b"b=2; Domain=.renox.app; HttpOnly",
            b"c=3; Domain=other-tenant.renox.app",
            b"d=4; Domain=shop.renox.app; SameSite=Lax",
            b"e=5; Path=/",
        ],
    )
    .await;
    assert_eq!(
        got,
        [
            "a=1; Path=/; Secure",
            "b=2; HttpOnly",
            "c=3",
            "d=4; Domain=shop.renox.app; SameSite=Lax",
            "e=5; Path=/",
        ]
    );
}

/// On a custom domain the tenant may scope to that hostname; a parent of
/// it is removed.
#[tokio::test]
async fn custom_domain_may_scope_to_itself_not_its_parent() {
    let got = set_cookies(
        "www.example.com",
        vec![
            b"a=1; Domain=www.example.com",
            b"b=2; Domain=example.com",
            b"c=3; Domain=renox.app",
        ],
    )
    .await;
    assert_eq!(got, ["a=1; Domain=www.example.com", "b=2", "c=3"]);
}

/// A malformed `Set-Cookie` is dropped, the valid ones around it stay.
#[tokio::test]
async fn malformed_set_cookie_is_dropped() {
    let got = set_cookies(
        "shop.renox.app",
        vec![
            b"ok=1",
            b"no-equals-sign",
            b"=no-name",
            b"bad name=v; Domain=shop.renox.app",
            b"ok2=2",
        ],
    )
    .await;
    assert_eq!(got, ["ok=1", "ok2=2"]);
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The process-wide log of this test binary. Global, not per test: tracing
/// caches each callsite's interest, so a thread-local subscriber misses
/// events once a parallel test has hit the callsite without one.
fn captured_log() -> &'static Captured {
    static LOG: OnceLock<Captured> = OnceLock::new();
    LOG.get_or_init(|| {
        let captured = Captured::default();
        let writer = captured.clone();
        tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .init();
        captured
    })
}

/// The warning names the cookie and the removed domain, never the value
/// (secrets never reach logs), and comes once per cell and cookie.
#[tokio::test]
async fn the_log_line_has_name_and_domain_never_the_value() {
    let captured = captured_log();
    let dir = tempfile::tempdir().unwrap();
    let app = gateway(dir.path()).router(Arc::new(CookieCell {
        cookies: vec![b"session=s3cr3t-value; Domain=renox.app; HttpOnly"],
    }));
    for _ in 0..3 {
        let resp = app
            .clone()
            .oneshot(request("logs.renox.app", "/fn"))
            .await
            .unwrap();
        assert_eq!(
            resp.headers()["set-cookie"],
            "session=s3cr3t-value; HttpOnly"
        );
    }

    let log = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    let lines: Vec<&str> = log.lines().filter(|l| l.contains("t_logs")).collect();
    assert_eq!(lines.len(), 1, "once per cell and cookie: {log}");
    let line = lines[0];
    assert!(line.contains("WARN"), "{line}");
    assert!(line.contains("cookie=session"), "{line}");
    assert!(line.contains("removed_domain=renox.app"), "{line}");
    assert!(!log.contains("s3cr3t"), "the value leaked: {log}");
}
