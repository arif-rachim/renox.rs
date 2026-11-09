//! B14 on the crate (#278; `docs/14-benchmarks.md` B14): 10,000 idle
//! WebSocket connections of one tenant, each served by `ws::serve` over an
//! in-memory duplex stream, subscribed to one topic, add at most 50 MB of
//! resident memory. The end-to-end B14 (gateway, cell, isolate heap) is
//! #282. Skipped on a host with less than 2 GB of memory, with a reason.
//! Run alone for a clean number: `cargo test -p renox-realtime --release
//! --test scale -- --nocapture`.
//!
//! `per_connection_heap_budget` (#522) counts the heap one idle connection
//! holds (hub state, outbound queue, `ws::serve` task, inbox) with a
//! counting allocator, so a fixed per-connection buffer that comes back
//! fails it on any host, without the noise of RSS.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::time::Duration;

use renox_realtime::{ConnInfo, Hub, Limits, Payload, Transport, ws};
use tokio::sync::mpsc;

/// Counts the heap bytes live on the current thread (allocated there minus
/// freed there). A current-thread runtime keeps a test's tasks on its
/// thread, so the count is the test's own.
struct Counting;

thread_local! {
    static LIVE: Cell<isize> = const { Cell::new(0) };
}

fn add(n: isize) {
    // `try_with`: no count while the thread's locals are torn down.
    let _ = LIVE.try_with(|c| c.set(c.get() + n));
}

// SAFETY: every call is forwarded to `System` unchanged; the counter is a
// const-initialised thread local, which never allocates.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            add(l.size() as isize);
        }
        p
    }

    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(l) };
        if !p.is_null() {
            add(l.size() as isize);
        }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        add(-(l.size() as isize));
    }

    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, new) };
        if !q.is_null() {
            add(new as isize - l.size() as isize);
        }
        q
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

fn live() -> isize {
    LIVE.with(Cell::get)
}

/// The tests measure the process; one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

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

// The guard only orders the tests of this file; nothing else takes it.
#[allow(clippy::await_holding_lock)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ten_thousand_idle_connections_within_50_mb() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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

/// The heap one idle WebSocket connection holds, without the in-memory
/// stream: the end-to-end B14 target (10,000 connections in 50 MB, about
/// 5 KB each) also has to hold the cell's task, the socket, and the
/// handshake's headers, so the crate's share is kept at 2 KB.
const PER_CONNECTION_BUDGET: isize = 2 * 1024;

#[test]
fn per_connection_heap_budget() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        const N: usize = 1_000;
        let hub = Hub::new(Limits {
            user_connections: N,
            ..Limits::paid()
        });
        // The streams and the test's own vectors are allocated first and
        // counted apart: they stand in for the socket, which is not ours.
        let mut streams = Vec::with_capacity(N);
        for _ in 0..N {
            streams.push(tokio::io::duplex(64));
        }
        let mut clients = Vec::with_capacity(N);
        let mut inboxes = Vec::with_capacity(N);
        // Warm the hub's maps and the runtime: one connection, then the
        // baseline.
        let warm = hub
            .connect(ConnInfo {
                user: "warm".into(),
                transport: Transport::Ws,
                last_event_id: None,
            })
            .unwrap();
        hub.subscribe(&warm.id, "room:lobby", true).unwrap();
        tokio::task::yield_now().await;
        let before = live();
        for i in 0..N {
            let conn = hub
                .connect(ConnInfo {
                    user: format!("u{}", i % 100),
                    transport: Transport::Ws,
                    last_event_id: None,
                })
                .unwrap();
            hub.subscribe(&conn.id, "room:lobby", true).unwrap();
            let (a, b) = streams.pop().unwrap();
            let (tx, rx) = ws::inbox(16);
            tokio::spawn(ws::serve(b, conn, tx));
            clients.push(a);
            inboxes.push(rx);
        }
        // Every serve task reaches its idle state.
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        let per = (live() - before) / N as isize;
        eprintln!("B14 crate budget: {per} heap bytes per idle connection (budget {PER_CONNECTION_BUDGET})");
        assert_eq!(hub.snapshot().live, N + 1);
        assert!(
            per <= PER_CONNECTION_BUDGET,
            "{per} bytes per idle connection, over the {PER_CONNECTION_BUDGET} budget"
        );
        // An idle inbox and an idle outbound queue hold nothing: a message
        // in and out still works.
        assert_eq!(hub.publish("room:lobby", Payload::text("hi")).unwrap(), N + 1);
        drop(clients);
        drop(inboxes);
        drop(warm);
    });
}
