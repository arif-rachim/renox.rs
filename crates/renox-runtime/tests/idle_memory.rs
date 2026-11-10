//! #680 task 1: after a burst of realtime runs, an isolate that goes idle
//! asks V8 for a memory-reducing collection, so the heap it keeps committed
//! comes back close to the heap in use (B14: each connection's `connect`
//! and `open` runs left about 3.7 KB of committed heap pages per
//! connection that V8 did not return within the 10 s hold).
#![cfg(feature = "v8")]

mod support;

use std::time::Duration;

use bytes::Bytes;
use renox_runtime::Runtime;
use renox_runtime::limits::Limits;
use renox_runtime::ops::realtime::{RealtimeCall, RealtimePhase};
use support::*;

const ROOM: &str = r#"
export const ws = {
  async open(ctx) {
    // What a chat `open` does with its ctx: read the params and the principal.
    const who = ctx.principal?.id ?? "anon";
    globalThis.__opened = (globalThis.__opened ?? 0) + (who.length > 0 ? 1 : 0) + (ctx.params.room.length > 0 ? 0 : 1);
  },
};
"#;

fn artifact() -> (std::path::PathBuf, String) {
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "idle", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": { "functions/ws/room": "functions/ws/room.js" } },
        "routes": [{ "kind": "ws", "path": "/ws/:room", "module": "functions/ws/room" }],
        "permissions": { "network": [], "secrets": [] },
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/ws/room.js", ROOM.as_bytes()),
    ])
}

fn run(phase: RealtimePhase, conn: &str) -> http::Request<Bytes> {
    let mut req = get("/ws/lobby");
    req.extensions_mut().insert(RealtimeCall {
        phase,
        conn: conn.into(),
        transport: renox_realtime::Transport::Ws,
        session: String::new(),
        data: None,
        close: None,
        principal: None,
    });
    req
}

/// 1,000 connect + `open` runs, then an idle period: one memory-reducing
/// collection ran, and the committed heap is within 2 MB of the heap in use.
#[tokio::test]
async fn an_idle_isolate_gives_heap_back_after_a_burst_of_realtime_runs() {
    let rt = Runtime::new(Default::default());
    let (dir, hash) = artifact();
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.max_isolates = 1;
    let iso = rt.create_isolate(s).await.unwrap();
    for i in 0..1000 {
        let conn = format!("c{i}");
        let out = iso
            .dispatch(
                ctx(&format!("req_idle_c_{i}")),
                run(RealtimePhase::Connect, ""),
            )
            .await;
        assert_eq!(out.response.status(), 200, "connect {i}");
        let out = iso
            .dispatch(
                ctx(&format!("req_idle_o_{i}")),
                run(RealtimePhase::Open, &conn),
            )
            .await;
        assert_eq!(out.response.status(), 200, "open {i}");
    }
    let before = iso.heap_stats()[0];
    let mut after = before;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        after = iso.heap_stats()[0];
        if after.memory_reductions > 0 {
            break;
        }
    }
    eprintln!(
        "after the burst: used {} KB, committed {} KB; after the idle collection: used {} KB, committed {} KB",
        before.used_bytes / 1024,
        before.total_bytes / 1024,
        after.used_bytes / 1024,
        after.total_bytes / 1024
    );
    assert_eq!(after.memory_reductions, 1, "{after:?}");
    assert!(
        after.total_bytes <= after.used_bytes + 2 * 1024 * 1024,
        "committed {} bytes, in use {}",
        after.total_bytes,
        after.used_bytes
    );
    // A request after the collection still works.
    let out = iso
        .dispatch(ctx("req_idle_after"), run(RealtimePhase::Connect, ""))
        .await;
    assert_eq!(out.response.status(), 200);
}

/// A handful of requests is not a burst: no collection runs.
#[tokio::test]
async fn a_few_requests_run_no_memory_reducing_collection() {
    let rt = Runtime::new(Default::default());
    let (dir, hash) = artifact();
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.max_isolates = 1;
    let iso = rt.create_isolate(s).await.unwrap();
    for i in 0..10 {
        iso.dispatch(
            ctx(&format!("req_idle_few_{i}")),
            run(RealtimePhase::Connect, ""),
        )
        .await;
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(iso.heap_stats()[0].memory_reductions, 0);
}
