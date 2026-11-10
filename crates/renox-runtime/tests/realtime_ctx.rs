//! #680 task 3: a realtime run builds its `Request` and `URL` only when the
//! handler reads `ctx.req`, `ctx.url` or `ctx.headers`. They stay getters
//! on the frozen ctx, return the same objects on every read within a run,
//! and carry the upgrade request's URL and headers as before.
#![cfg(feature = "v8")]

mod support;

use bytes::Bytes;
use renox_runtime::Runtime;
use renox_runtime::limits::Limits;
use renox_runtime::ops::realtime::{RealtimeCall, RealtimePhase};
use support::*;

const ROOM: &str = r#"
export const ws = {
  async open(ctx) {
    const d = Object.getOwnPropertyDescriptor(ctx, "req");
    globalThis.__probe = {
      accessor: typeof d?.get === "function",
      frozen: Object.isFrozen(ctx),
      room: ctx.params.room,
    };
  },
  async message(ctx) {
    const req = ctx.req;
    globalThis.__probe = {
      same: req === ctx.req && ctx.url === ctx.url && ctx.headers === req.headers,
      method: req.method,
      path: ctx.url.pathname,
      header: ctx.headers.get("x-probe"),
      data: ctx.data,
    };
  },
};
"#;

const PROBE: &str = r#"
export function GET() { return Response.json(globalThis.__probe ?? null); }
"#;

fn artifact() -> (std::path::PathBuf, String) {
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "rtctx", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/ws/room": "functions/ws/room.js",
            "functions/probe": "functions/probe.js",
        } },
        "routes": [
            { "kind": "ws", "path": "/ws/:room", "module": "functions/ws/room" },
            { "kind": "function", "method": "GET", "path": "/probe", "module": "functions/probe", "export": "GET" },
        ],
        "permissions": { "network": [], "secrets": [] },
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/ws/room.js", ROOM.as_bytes()),
        ("code/functions/probe.js", PROBE.as_bytes()),
    ])
}

fn run(phase: RealtimePhase, text: Option<&str>) -> http::Request<Bytes> {
    let mut req = http::Request::builder()
        .method("GET")
        .uri("https://test.renox.app/ws/lobby?x=1")
        .header("x-probe", "yes")
        .body(Bytes::new())
        .unwrap();
    req.extensions_mut().insert(RealtimeCall {
        phase,
        conn: "c1".into(),
        transport: renox_realtime::Transport::Ws,
        session: String::new(),
        data: text.map(|t| renox_runtime::ops::realtime::RealtimeData::Text(t.into())),
        close: None,
        principal: None,
    });
    req
}

async fn probe(iso: &renox_runtime::IsolateHandle, id: &str) -> serde_json::Value {
    let out = iso.dispatch(ctx(id), get("/probe")).await;
    body_json(&out.response)
}

#[tokio::test]
async fn the_realtime_ctx_builds_its_request_and_url_on_first_read() {
    let rt = Runtime::new(Default::default());
    let (dir, hash) = artifact();
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.max_isolates = 1;
    let iso = rt.create_isolate(s).await.unwrap();
    let out = iso
        .dispatch(ctx("req_rtctx_open"), run(RealtimePhase::Open, None))
        .await;
    assert_eq!(out.response.status(), 200);
    assert_eq!(
        probe(&iso, "req_rtctx_p1").await,
        serde_json::json!({ "accessor": true, "frozen": true, "room": "lobby" })
    );
    let out = iso
        .dispatch(
            ctx("req_rtctx_msg"),
            run(RealtimePhase::Message, Some("hi")),
        )
        .await;
    assert_eq!(out.response.status(), 200);
    assert_eq!(
        probe(&iso, "req_rtctx_p2").await,
        serde_json::json!({ "same": true, "method": "GET", "path": "/ws/lobby", "header": "yes", "data": "hi" })
    );
}
