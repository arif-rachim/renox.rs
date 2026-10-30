//! B14 on the crate (#278; `docs/14-benchmarks.md` B14): 10,000 idle
//! WebSocket connections of one tenant, each served by `ws::serve` over an
//! in-memory duplex stream, subscribed to one topic, add at most 50 MB of
//! resident memory. The end-to-end B14 (gateway, cell, isolate heap) is
//! #282. Skipped on a host with less than 2 GB of memory, with a reason.
//! Run alone for a clean number: `cargo test -p renox-realtime --release
//! --test scale -- --nocapture`.

use std::time::Duration;

use renox_realtime::{ConnInfo, Hub, Limits, Payload, Transport, ws};
use tokio::sync::mpsc;

fn rss_bytes() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages * 4096)
}

fn mem_total_bytes() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb: u64 = info
        .lines()
        .find(|l| l.starts_with("MemTotal:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some(kb * 1024)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ten_thousand_idle_connections_within_50_mb() {
    let (Some(before), Some(total)) = (rss_bytes(), mem_total_bytes()) else {
        eprintln!("skipped: no /proc (RSS cannot be measured on this host)");
        return;
    };
    if total < 2 * 1024 * 1024 * 1024 {
        eprintln!(
            "skipped: {} MB of memory, below the 2 GB this test needs",
            total / 1024 / 1024
        );
        return;
    }
    const N: usize = 10_000;
    let hub = Hub::new(Limits {
        user_connections: N,
        ..Limits::paid()
    });
    let mut clients = Vec::with_capacity(N);
    let mut inboxes = Vec::with_capacity(N);
    for i in 0..N {
        let conn = hub
            .connect(ConnInfo {
                user: format!("u{}", i % 100),
                transport: Transport::Ws,
                last_event_id: None,
            })
            .unwrap();
        hub.subscribe(&conn.id, "room:lobby", true).unwrap();
        let (a, b) = tokio::io::duplex(4096);
        let (tx, rx) = mpsc::channel(16);
        tokio::spawn(ws::serve(b, conn, tx));
        clients.push(a);
        inboxes.push(rx);
    }
    // Let every serve task reach its idle state.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after = rss_bytes().unwrap();
    let delta = after.saturating_sub(before);
    let s = hub.snapshot();
    eprintln!(
        "B14 crate: {N} idle connections, RSS {} MB -> {} MB, delta {:.1} MB ({} bytes per connection), live {}",
        before / 1024 / 1024,
        after / 1024 / 1024,
        delta as f64 / 1024.0 / 1024.0,
        delta / N as u64,
        s.live
    );
    assert_eq!(s.live, N);
    assert!(delta <= 50 * 1024 * 1024, "{delta} bytes over 50 MB");
    // Fan-out to all of them is one publish and queues for each.
    assert_eq!(
        hub.publish("room:lobby", Payload::text("hello")).unwrap(),
        N
    );
    drop(clients);
    drop(inboxes);
}
