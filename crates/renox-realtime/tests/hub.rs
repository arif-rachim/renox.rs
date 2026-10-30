//! #278: every row of the limits table of `ops.md` 1.5.0 section 18 on the
//! crate (`docs/23-failure-modes.md`, "WebSocket message flood";
//! `docs/24-threat-model.md` B, "Realtime fan-out amplification").

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Client, frame};
use renox_realtime::{
    ConnInfo, Hub, LimitReason, Limits, Outbound, Payload, RealtimeError, Transport, close, sse, ws,
};
use tokio::sync::mpsc;
use tokio::time::Instant;

fn info(user: &str) -> ConnInfo {
    ConnInfo {
        user: user.into(),
        transport: Transport::Ws,
        last_event_id: None,
    }
}

/// A served WebSocket connection: the client side, the inbound messages,
/// the serve task.
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

#[tokio::test]
async fn tenant_and_user_caps() {
    let hub = Hub::new(Limits {
        tenant_connections: 3,
        user_connections: 2,
        ..Limits::free()
    });
    let a1 = hub.connect(info("a")).unwrap();
    let _a2 = hub.connect(info("a")).unwrap();
    assert_eq!(
        hub.connect(info("a")).err(),
        Some(RealtimeError::Limit(LimitReason::User))
    );
    let _b1 = hub.connect(info("b")).unwrap();
    assert_eq!(
        hub.connect(info("c")).err(),
        Some(RealtimeError::Limit(LimitReason::Tenant))
    );
    assert_eq!(
        RealtimeError::Limit(LimitReason::Tenant).code(),
        "RENOX_REALTIME_LIMIT"
    );
    drop(a1);
    assert_eq!(hub.user_connections("a"), 1);
    assert!(hub.connect(info("c")).is_ok(), "a freed slot is reusable");
    let s = hub.snapshot();
    assert_eq!(
        (s.refused.get("user"), s.refused.get("tenant")),
        (Some(&1), Some(&1))
    );
    // The defaults are docs/04's.
    assert_eq!(
        (
            Limits::free().tenant_connections,
            Limits::paid().tenant_connections,
            Limits::free().user_connections
        ),
        (100, 10_000, 10)
    );
}

#[tokio::test]
async fn topics_per_connection_and_bad_topics() {
    let hub = Hub::new(Limits {
        topics_per_connection: 2,
        ..Limits::free()
    });
    let c = hub.connect(info("a")).unwrap();
    hub.subscribe(&c.id, "room:1", true).unwrap();
    hub.subscribe(&c.id, "room:1", true).unwrap();
    hub.subscribe(&c.id, "room:2", true).unwrap();
    assert_eq!(
        hub.subscribe(&c.id, "room:3", true),
        Err(RealtimeError::Limit(LimitReason::Topics))
    );
    assert_eq!(
        hub.subscribe(&c.id, "room:4", false),
        Err(RealtimeError::Forbidden)
    );
    for bad in ["", "room::1", "room 1", "x:y/z", &"a".repeat(257)] {
        assert_eq!(
            hub.subscribe(&c.id, bad, true),
            Err(RealtimeError::BadTopic),
            "{bad:?}"
        );
    }
    // Unknown connections are ignored, not errors.
    assert_eq!(hub.subscribe("c999", "room:1", true), Ok(()));
    hub.send("c999", Payload::text("x")).unwrap();
}

#[tokio::test]
async fn outbound_message_size() {
    let hub = Hub::new(Limits::free());
    let c = hub.connect(info("a")).unwrap();
    hub.subscribe(&c.id, "t", true).unwrap();
    let big = "x".repeat(64 * 1024 + 1);
    assert_eq!(
        hub.publish("t", Payload::text(big.clone())),
        Err(RealtimeError::Limit(LimitReason::MessageSize))
    );
    assert_eq!(
        hub.send(&c.id, Payload::html(big)),
        Err(RealtimeError::Limit(LimitReason::MessageSize))
    );
    assert_eq!(
        hub.publish("t", Payload::text("x".repeat(64 * 1024))),
        Ok(1)
    );
}

/// A consumer that does not read is closed with 1008 when its 256-message
/// queue is full; the publisher never waits and others keep receiving.
#[tokio::test(start_paused = true)]
async fn slow_consumer_closed_with_1008_publish_never_waits() {
    let hub = Hub::new(Limits::free());
    let slow = hub.connect(info("slow")).unwrap();
    let mut fast = hub.connect(info("fast")).unwrap();
    hub.subscribe(&slow.id, "t", true).unwrap();
    hub.subscribe(&fast.id, "t", true).unwrap();
    let t0 = Instant::now();
    for i in 0..300 {
        hub.publish("t", Payload::text(format!("m{i}"))).unwrap();
        // The fast one keeps up.
        assert!(matches!(fast.rx.try_recv(), Ok(Outbound::Message(_))));
    }
    assert_eq!(Instant::now(), t0, "publish never awaited");
    assert!(slow.is_closed());
    let c = slow.closed().await;
    assert_eq!((c.code, c.reason.as_str()), (close::POLICY, "backpressure"));
    assert!(!fast.is_closed());
    assert_eq!(hub.snapshot().closes.get("backpressure"), Some(&1));
    // Once closed, the slow one gets nothing more and does not count.
    assert_eq!(hub.publish("t", Payload::text("after")).unwrap(), 1);
}

/// An inbound frame over 64 KB closes the connection with 1009 before the
/// payload is buffered.
#[tokio::test]
async fn oversized_frame_closed_with_1009() {
    let hub = Hub::new(Limits::free());
    let (mut client, mut inbound, _, task) = served(&hub, "a");
    client.send_text("hello").await;
    assert_eq!(
        inbound.recv().await,
        Some(ws::Inbound::Text("hello".into()))
    );
    // The header claims 64 KB + 1; no payload is sent at all.
    let mut head = vec![0x81u8, 0x80 | 127];
    head.extend_from_slice(&(64u64 * 1024 + 1).to_be_bytes());
    head.extend_from_slice(&[1, 2, 3, 4]);
    client.send_raw(&head).await.unwrap();
    let (op, p) = client.next().await.unwrap();
    assert_eq!((op, Client::code(&p)), (0x8, close::TOO_BIG));
    let closed = task.await.unwrap();
    assert_eq!(
        (closed.code, closed.reason.as_str()),
        (close::TOO_BIG, "message_size")
    );
    // Fragments count together.
    let (mut client, _inbound, _, task) = served(&hub, "b");
    let half = vec![b'x'; 40 * 1024];
    client.send_raw(&frame(0x1, false, &half)).await.unwrap();
    client.send_raw(&frame(0x0, true, &half)).await.unwrap();
    let (op, p) = client.next().await.unwrap();
    assert_eq!((op, Client::code(&p)), (0x8, close::TOO_BIG));
    assert_eq!(task.await.unwrap().code, close::TOO_BIG);
}

/// A flood on one connection (more than 100 messages in a second) closes
/// it with 1008 and does not delay another connection's delivery (fake
/// clock: the delivery happens at the same instant).
#[tokio::test(start_paused = true)]
async fn flood_closes_that_connection_only() {
    let hub = Hub::new(Limits::free());
    let (mut flooder, mut flood_in, _, flood_task) = served(&hub, "a");
    let (mut other, _other_in, other_id, _other_task) = served(&hub, "b");
    hub.subscribe(&other_id, "news", true).unwrap();
    // Drain the flooder's inbound messages as the cell would.
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
    hub.publish("news", Payload::text("headline")).unwrap();
    let (op, p) = other.next().await.unwrap();
    assert_eq!((op, p.as_slice()), (0x1, b"headline".as_slice()));
    assert_eq!(
        Instant::now(),
        t0,
        "delivery to the other connection was not delayed"
    );
    let closed = flood_task.await.unwrap();
    assert_eq!(
        (closed.code, closed.reason.as_str()),
        (close::POLICY, "flood")
    );
    // 100 per second is allowed: a second later the window starts again.
    let (mut steady, mut steady_in, _, steady_task) = served(&hub, "c");
    for round in 0..3 {
        for i in 0..100 {
            steady.send_text(&format!("{round}-{i}")).await;
            assert!(steady_in.recv().await.is_some());
        }
        tokio::time::advance(Duration::from_millis(1001)).await;
    }
    assert!(!steady_task.is_finished());
}

/// Without a pong within 10 s of a ping (sent every 30 s), the connection
/// is closed with 1001; a client that answers stays open.
#[tokio::test(start_paused = true)]
async fn heartbeat_timeout_closes() {
    let hub = Hub::new(Limits::free());
    let (mut silent, _i1, _, silent_task) = served(&hub, "a");
    let (mut alive, _i2, _, alive_task) = served(&hub, "b");
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(
        silent.read().await.map(|f| f.0),
        Some(0x9),
        "a ping at 30 s"
    );
    // `alive` answers its ping.
    let (op, p) = alive.read().await.unwrap();
    assert_eq!(op, 0x9);
    alive.send_raw(&frame(0xA, true, &p)).await.unwrap();
    tokio::time::sleep(Duration::from_secs(11)).await;
    let (op, p) = silent.read().await.unwrap();
    assert_eq!((op, Client::code(&p)), (0x8, close::GOING_AWAY));
    let c = silent_task.await.unwrap();
    assert_eq!(c.reason, "heartbeat");
    assert!(!alive_task.is_finished());
    assert_eq!(hub.snapshot().closes.get("heartbeat"), Some(&1));
}

/// An SSE reconnect with `Last-Event-ID` inside the buffer gets the missed
/// events of the topics it subscribes to; outside the 60 s window, none.
#[tokio::test(start_paused = true)]
async fn replay_after_reconnect_with_last_event_id() {
    let hub = Hub::new(Limits::free());
    let mut ids = Vec::new();
    {
        let first = hub
            .connect(ConnInfo {
                user: "a".into(),
                transport: Transport::Sse,
                last_event_id: None,
            })
            .unwrap();
        hub.subscribe(&first.id, "orders:o1", true).unwrap();
        for i in 0..5 {
            hub.publish(
                "orders:o1",
                Payload::json(serde_json::json!({ "n": i })).with_event("order-updated"),
            )
            .unwrap();
        }
        hub.publish("other", Payload::text("not mine")).unwrap();
        let mut first = first;
        while let Ok(Outbound::Message(e)) = first.rx.try_recv() {
            ids.push(e.id);
        }
        // The client saw only the first two before the connection dropped.
    }
    let again = hub
        .connect(ConnInfo {
            user: "a".into(),
            transport: Transport::Sse,
            last_event_id: Some(ids[1]),
        })
        .unwrap();
    hub.subscribe(&again.id, "orders:o1", true).unwrap();
    let mut again = again;
    let mut got = Vec::new();
    while let Ok(Outbound::Message(e)) = again.rx.try_recv() {
        got.push((
            e.id,
            e.event.as_deref().map(str::to_string),
            e.data.to_string(),
        ));
    }
    assert_eq!(
        got.iter().map(|g| g.0).collect::<Vec<_>>(),
        ids[2..].to_vec()
    );
    assert_eq!(got[0].1.as_deref(), Some("order-updated"));
    assert_eq!(got[0].2, r#"{"n":2}"#);
    drop(again);
    // Past the window: nothing to replay.
    tokio::time::advance(Duration::from_secs(61)).await;
    let late = hub
        .connect(ConnInfo {
            user: "a".into(),
            transport: Transport::Sse,
            last_event_id: Some(ids[1]),
        })
        .unwrap();
    hub.subscribe(&late.id, "orders:o1", true).unwrap();
    let mut late = late;
    assert!(late.rx.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn sse_wire_format_and_keepalive() {
    let hub = Hub::new(Limits::free());
    let conn = hub
        .connect(ConnInfo {
            user: "a".into(),
            transport: Transport::Sse,
            last_event_id: None,
        })
        .unwrap();
    let id = conn.id.clone();
    let (a, mut b) = tokio::io::duplex(64 * 1024);
    let task = tokio::spawn(sse::serve(a, conn));
    hub.subscribe(&id, "orders:o1", true).unwrap();
    hub.publish(
        "orders:o1",
        Payload::html("<li>1</li>\n<li>2</li>").with_event("order-updated"),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_secs(16)).await;
    hub.close(&id, close::NORMAL, "done");
    let closed = task.await.unwrap();
    assert_eq!(closed.reason, "done");
    let mut out = String::new();
    tokio::io::AsyncReadExt::read_to_string(&mut b, &mut out)
        .await
        .unwrap();
    let first_id = out
        .split("id: ")
        .nth(1)
        .unwrap()
        .split('\n')
        .next()
        .unwrap()
        .to_string();
    assert_eq!(
        out,
        format!(
            "retry: 1000\n\nid: {first_id}\nevent: order-updated\ndata: <li>1</li>\ndata: <li>2</li>\n\n: keep-alive\n\n"
        )
    );
    assert_eq!(sse::last_event_id(Some(" 42 ")), Some(42));
    assert_eq!(sse::last_event_id(Some("x")), None);
}

/// The counters the meter needs: live, connection-seconds, messages in and
/// out, closes by reason; a client close is echoed and recorded.
#[tokio::test(start_paused = true)]
async fn counters_and_client_close() {
    let hub = Hub::new(Limits::free());
    let (mut c, mut inbound, id, task) = served(&hub, "a");
    hub.subscribe(&id, "t", true).unwrap();
    c.send_text("one").await;
    assert!(inbound.recv().await.is_some());
    hub.publish("t", Payload::text("two")).unwrap();
    assert_eq!(c.next().await.unwrap().1, b"two");
    assert_eq!(hub.snapshot().live, 1);
    tokio::time::sleep(Duration::from_secs(5)).await;
    c.send_raw(&frame(0x8, true, &1000u16.to_be_bytes()))
        .await
        .unwrap();
    let (op, p) = c.read().await.unwrap();
    assert_eq!((op, Client::code(&p)), (0x8, 1000));
    let closed = task.await.unwrap();
    assert_eq!((closed.code, closed.reason.as_str()), (1000, "client"));
    let s = hub.snapshot();
    assert_eq!(
        (
            s.live,
            s.messages_in,
            s.messages_out,
            s.closes.get("client")
        ),
        (0, 1, 1, Some(&1))
    );
    assert!(s.connection_seconds >= 5.0, "{}", s.connection_seconds);
}
