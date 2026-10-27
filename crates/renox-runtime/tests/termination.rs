//! Issue #89: a request that is terminated (CPU limit, heap limit,
//! wall-clock deadline) releases what its ops hold before the isolate is
//! disposed: the open transaction is rolled back and the writer is free for
//! the next request; a fetch still waiting for its response is aborted.
//! `docs/23-failure-modes.md` section 1, "Watchdog fires while a DB
//! transaction is open". V8-linked.
#![cfg(feature = "v8")]

mod support;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use renox_data::{DbOptions, TenantDb, Value};
use renox_runtime::isolate::MeterStatus;
use renox_runtime::limits::Limits;
use renox_runtime::ops::db::{DbHandle, StmtKind};
use renox_runtime::ops::fetch::FetchConfig;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{IsolateHandle, RequestCtx, Runtime, RuntimeConfig};
use support::*;
use tokio::io::AsyncReadExt;

const SRC: &str = r#"
    export async function POST({ db, url }) {
        const how = url.searchParams.get("how");
        await db.transaction(async (tx) => {
            await tx.execute("insert into app__items (name) values ('lost')");
            if (how === "cpu") while (true) {}
            if (how === "oom") { const a = []; while (true) a.push(new Array(1e6).fill(1)); }
            if (how === "wait") await new Promise(() => {});
        });
        return new Response("committed");
    }
    export async function GET({ db }) {
        await db.execute("insert into app__items (name) values ('next')");
        const rows = await db.query("select name from app__items order by id");
        return Response.json(rows.map((r) => r.name));
    }
"#;

fn runtime(fetch: FetchConfig) -> (Runtime, Arc<MemoryLogSink>) {
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        fetch,
    });
    (rt, sink)
}

fn tenant_db() -> DbHandle {
    let path = scratch("termination").join("app.db");
    let db = TenantDb::open(&path, DbOptions::default()).unwrap();
    db.execute(
        "create table app__items (id integer primary key, name text not null)",
        &[],
    )
    .unwrap();
    DbHandle::spawn(db).unwrap()
}

async fn isolate(rt: &Runtime, db: &DbHandle, limits: Limits) -> IsolateHandle {
    let (dir, hash) = function_artifact(SRC, &[("POST", "/"), ("GET", "/")], &[]);
    let mut s = spec(&dir, &hash, limits);
    s.db = Some(db.clone());
    rt.create_isolate(s).await.unwrap()
}

fn post(how: &str) -> http::Request<Bytes> {
    http::Request::builder()
        .method("POST")
        .uri(format!("https://test.renox.app/?how={how}"))
        .body(Bytes::new())
        .unwrap()
}

/// The writer is free: a write from outside the isolate succeeds within
/// 10 ms of the terminated request's answer.
async fn assert_writer_free(db: &DbHandle) {
    let start = Instant::now();
    let m = db
        .statement(
            StmtKind::Execute,
            "insert into app__items (name) values (?)".into(),
            vec![Value::Text("probe".into())],
            None,
            Instant::now() + Duration::from_secs(5),
        )
        .await;
    let took = start.elapsed();
    assert!(m.value.is_ok(), "{:?}", m.value);
    assert!(took < Duration::from_millis(10), "writer held: {took:?}");
}

/// The row written inside the terminated transaction is absent, and a
/// follow-up request on the same tenant writes and reads normally.
async fn assert_rolled_back(iso: &IsolateHandle) {
    let out = iso.dispatch(ctx("req_term_next_01"), get("/")).await;
    assert_eq!(out.response.status(), 200, "{:?}", out.response.body());
    assert_eq!(
        body_json(&out.response),
        serde_json::json!(["probe", "next"])
    );
}

/// CPU limit inside `db.transaction`: 503 `RENOX_CPU_LIMIT`, rollback,
/// writer released.
#[tokio::test]
async fn cpu_limit_inside_a_transaction_rolls_back_and_releases_the_writer() {
    let (rt, _) = runtime(FetchConfig::default());
    let db = tenant_db();
    let iso = isolate(&rt, &db, Limits::FREE).await;
    let out = iso.dispatch(ctx("req_term_cpu_001"), post("cpu")).await;
    assert_eq!(out.response.status(), 503);
    assert_eq!(out.meter.status, MeterStatus::CpuLimit);
    assert_writer_free(&db).await;
    assert_eq!(rt.metrics().rolled_back_on_termination(), 1);
    assert_rolled_back(&iso).await;
}

/// Heap limit inside `db.transaction`: 503 `RENOX_OOM`, rollback, writer
/// released.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oom_inside_a_transaction_rolls_back_and_releases_the_writer() {
    let (rt, _) = runtime(FetchConfig::default());
    let db = tenant_db();
    let limits = Limits {
        heap_bytes: 32 * 1024 * 1024,
        cpu_ms: 5_000,
        ..Limits::FREE
    };
    let iso = isolate(&rt, &db, limits).await;
    let out = iso.dispatch(ctx("req_term_oom_001"), post("oom")).await;
    assert_eq!(out.response.status(), 503);
    assert_eq!(out.meter.status, MeterStatus::Oom);
    assert_writer_free(&db).await;
    assert_eq!(rt.metrics().rolled_back_on_termination(), 1);
    assert_rolled_back(&iso).await;
}

/// Wall-clock deadline inside `db.transaction`: 504 `RENOX_DEADLINE`,
/// rollback, writer released; the isolate is kept.
#[tokio::test]
async fn deadline_inside_a_transaction_rolls_back_and_releases_the_writer() {
    let (rt, _) = runtime(FetchConfig::default());
    let db = tenant_db();
    let iso = isolate(&rt, &db, Limits::FREE).await;
    let short = RequestCtx {
        request_id: "req_term_wall_01".into(),
        deadline: Instant::now() + Duration::from_millis(300),
    };
    let out = iso.dispatch(short, post("wait")).await;
    assert_eq!(out.response.status(), 504);
    assert_eq!(out.meter.status, MeterStatus::Timeout);
    assert_writer_free(&db).await;
    assert_eq!(rt.metrics().rolled_back_on_termination(), 1);
    assert_eq!(rt.metrics().recycles(), 0);
    assert_rolled_back(&iso).await;
}

/// A fetch waiting for its response when the CPU limit ends the request is
/// aborted: the server sees its connection closed.
#[tokio::test]
async fn pending_fetch_is_aborted_when_the_request_is_terminated() {
    // A server that reads the request head and never answers; it reports
    // when the client closes the connection.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<Instant>();
    tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        loop {
            match s.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => continue,
            }
        }
        let _ = closed_tx.send(Instant::now());
    });
    let public: IpAddr = "93.184.216.34".parse().unwrap();
    let names: HashMap<String, Vec<IpAddr>> =
        [("api.example.com".to_string(), vec![public])].into();
    let mut config = FetchConfig::with_resolver(Arc::new(StaticResolver(names)));
    config
        .connect_override
        .insert(SocketAddr::new(public, 80), addr);
    let (rt, _) = runtime(config);
    let src = r#"
        export async function GET() {
            const p = fetch("http://api.example.com/hang");
            setTimeout(() => { while (true) {} }, 200);
            await p;
            return new Response("unreachable");
        }
    "#;
    let (dir, hash) = function_artifact(src, &[("GET", "/")], &["http://api.example.com"]);
    let iso = rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let out = iso.dispatch(ctx("req_term_fetch_1"), get("/")).await;
    let answered = Instant::now();
    assert_eq!(out.response.status(), 503);
    assert_eq!(out.meter.status, MeterStatus::CpuLimit);
    let closed = tokio::time::timeout(Duration::from_secs(2), closed_rx)
        .await
        .expect("the server never saw the connection close")
        .unwrap();
    assert!(
        closed.saturating_duration_since(answered) < Duration::from_secs(1),
        "closed {:?} after the answer",
        closed.saturating_duration_since(answered)
    );
}
