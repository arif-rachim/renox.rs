//! #118: the realtime hardening of `docs/24-threat-model.md` A ("Cross-site
//! WebSocket hijacking", "Subscribing to another user's topic") and B
//! ("Realtime fan-out amplification"): the `Origin` check of an upgrade, a
//! subscribe that the policy did not allow is refused (fail closed), and a
//! flood on one tenant's connection does not delay another tenant's.

mod common;

use std::sync::Arc;

use common::{Client, frame};
use renox_realtime::origin::{OriginRefusal, Upgrade, check};
use renox_realtime::{ConnInfo, Hub, Limits, Payload, RealtimeError, Transport, ws};
use tokio::sync::mpsc;
use tokio::time::Instant;

const HOST: &str = "shop.renox.app";

#[test]
fn origin_same_host_and_cors_origins_pass_any_other_site_is_refused() {
    let cors = vec!["https://admin.example.com".to_string(), "*".to_string()];
    // The app's own host, whatever the scheme (renox dev serves http).
    assert_eq!(
        check(Upgrade::Ws, Some("https://shop.renox.app"), HOST, &[], true),
        Ok(())
    );
    assert_eq!(
        check(Upgrade::Ws, Some("http://SHOP.renox.app"), HOST, &[], true),
        Ok(())
    );
    // An allowed CORS origin, exactly; `*` allows nothing for a credentialed socket.
    assert_eq!(
        check(
            Upgrade::Ws,
            Some("https://admin.example.com"),
            HOST,
            &cors,
            true
        ),
        Ok(())
    );
    assert_eq!(
        check(Upgrade::Ws, Some("https://evil.example"), HOST, &cors, true),
        Err(OriginRefusal::Mismatch)
    );
    assert_eq!(
        check(
            Upgrade::Ws,
            Some("https://shop.renox.app.evil.example"),
            HOST,
            &[],
            true
        ),
        Err(OriginRefusal::Mismatch)
    );
    assert_eq!(
        check(
            Upgrade::Ws,
            Some("https://shop.renox.app:8443"),
            HOST,
            &[],
            true
        ),
        Err(OriginRefusal::Mismatch)
    );
    // `null` (a sandboxed frame, a file: page) and junk.
    for bad in [
        "null",
        "shop.renox.app",
        "ftp://shop.renox.app",
        "https://shop.renox.app/path",
        "https://user@shop.renox.app",
        "",
    ] {
        assert_eq!(
            check(Upgrade::Ws, Some(bad), HOST, &[], true),
            Err(OriginRefusal::Malformed),
            "{bad:?}"
        );
    }
    // SSE: a mismatch is refused too.
    assert_eq!(
        check(Upgrade::Sse, Some("https://evil.example"), HOST, &[], true),
        Err(OriginRefusal::Mismatch)
    );
}

#[test]
fn origin_absent_a_websocket_with_a_cookie_is_refused() {
    // Browsers always send Origin on a WebSocket upgrade: none plus a cookie is not a browser we trust.
    assert_eq!(
        check(Upgrade::Ws, None, HOST, &[], true),
        Err(OriginRefusal::Missing)
    );
    // No cookie, no ambient credential: a non-browser client.
    assert_eq!(check(Upgrade::Ws, None, HOST, &[], false), Ok(()));
    // SSE: browsers omit Origin on a same-origin GET; CORS guards cross-site reads.
    assert_eq!(check(Upgrade::Sse, None, HOST, &[], true), Ok(()));
}

fn info(user: &str) -> ConnInfo {
    ConnInfo {
        user: user.into(),
        transport: Transport::Ws,
        last_event_id: None,
    }
}

#[test]
fn a_subscribe_the_policy_did_not_allow_is_refused() {
    let hub = Hub::new(Limits::free());
    let conn = hub.connect(info("u_alice")).unwrap();
    // The cell passes the policy's decision; false (or no permitting policy) is a refusal, and nothing is subscribed.
    assert!(matches!(
        hub.subscribe(&conn.id, "user:u_bob:inbox", false),
        Err(RealtimeError::Forbidden)
    ));
    assert_eq!(hub.subscribers("user:u_bob:inbox"), 0);
    hub.subscribe(&conn.id, "user:u_alice:inbox", true).unwrap();
    assert_eq!(hub.subscribers("user:u_alice:inbox"), 1);
}

fn served(
    hub: &Arc<Hub>,
    user: &str,
) -> (
    Client,
    mpsc::Receiver<ws::Inbound>,
    String,
    tokio::task::JoinHandle<renox_realtime::Closed>,
) {
    let conn = hub.connect(info(user)).unwrap();
    let id = conn.id.clone();
    let (a, b) = tokio::io::duplex(256 * 1024);
    let (tx, rx) = mpsc::channel(16);
    let task = tokio::spawn(ws::serve(b, conn, tx));
    (Client { io: a }, rx, id, task)
}

/// One hub per tenant (the cell's): tenant A's flooding connection is closed
/// on its own, and tenant B's connection gets its message at the same
/// instant (paused clock).
#[tokio::test(start_paused = true)]
async fn a_flood_on_one_tenant_does_not_delay_another_tenant() {
    let tenant_a = Hub::new(Limits::free());
    let tenant_b = Hub::new(Limits::free());
    let (mut flooder, mut flood_in, _, flood_task) = served(&tenant_a, "a");
    let (mut other, _other_in, other_id, _other_task) = served(&tenant_b, "b");
    tenant_b.subscribe(&other_id, "news", true).unwrap();
    tokio::spawn(async move { while flood_in.recv().await.is_some() {} });
    for i in 0..150 {
        if flooder
            .send_raw(&frame(0x1, true, format!("spam {i}").as_bytes()))
            .await
            .is_err()
        {
            break;
        }
    }
    let t0 = Instant::now();
    tenant_b.publish("news", Payload::text("headline")).unwrap();
    let (op, p) = other.next().await.unwrap();
    assert_eq!((op, p.as_slice()), (0x1, b"headline".as_slice()));
    assert_eq!(Instant::now(), t0, "tenant B's delivery was not delayed");
    let closed = flood_task.await.unwrap();
    assert_eq!(closed.reason.as_str(), "flood");
}
