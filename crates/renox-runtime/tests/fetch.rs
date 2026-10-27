//! Issue #27: tenant `fetch` through `op_fetch` with the host allowlist,
//! SSRF blocking after DNS resolution, the egress byte limit, and the
//! request deadline (`docs/contracts/ops.md` section 2).
//!
//! The servers listen on 127.0.0.1, which the policy blocks. Names resolve
//! (through a fake resolver) to a public documentation-free address,
//! `93.184.216.34`, which the policy accepts; the `test-hooks` connect
//! override then maps that vetted address to the local server. Every policy
//! check runs for real; only the final TCP destination is redirected.
#![cfg(feature = "v8")]

mod support;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use renox_runtime::isolate::MeterStatus;
use renox_runtime::limits::Limits;
use renox_runtime::ops::fetch::FetchConfig;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{IsolateHandle, RequestCtx, Runtime, RuntimeConfig};
use support::http_server::TestServer;
use support::*;

const PUBLIC: &str = "93.184.216.34";

struct Env {
    rt: Runtime,
    sink: Arc<MemoryLogSink>,
    server: TestServer,
}

async fn env() -> Env {
    let server = support::http_server::start().await;
    let public: IpAddr = PUBLIC.parse().unwrap();
    let mut names: HashMap<String, Vec<IpAddr>> = HashMap::new();
    for n in [
        "api.example.com",
        "a.b.example.com",
        "x.example.com",
        "example.com",
        "other.test",
    ] {
        names.insert(n.into(), vec![public]);
    }
    names.insert(
        "private.example.com".into(),
        vec!["10.0.0.5".parse().unwrap()],
    );
    names.insert(
        "mixed.example.com".into(),
        vec![public, "127.0.0.1".parse().unwrap()],
    );
    names.insert(
        "mapped.example.com".into(),
        vec!["::ffff:127.0.0.1".parse().unwrap()],
    );
    names.insert(
        "metadata.example.com".into(),
        vec!["169.254.169.254".parse().unwrap()],
    );
    let mut config = FetchConfig::with_resolver(Arc::new(StaticResolver(names)));
    config
        .connect_override
        .insert(SocketAddr::new(public, 80), server.addr);
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        fetch: config,
    });
    Env { rt, sink, server }
}

/// A handler that fetches `?url=` and reports the outcome as JSON.
const PROBE: &str = r#"
    export async function GET({ url }) {
        const target = url.searchParams.get("url");
        const read = url.searchParams.get("read") === "1";
        try {
            const r = await fetch(target, { headers: { authorization: "Bearer t0k" } });
            const body = read || r.status < 300 ? await r.text() : "";
            return Response.json({ ok: true, status: r.status, body: body.slice(0, 200), redirected: r.redirected, url: r.url });
        } catch (e) {
            return Response.json({ ok: false, code: e.code ?? null, details: e.details ?? null, name: e.name, message: String(e.message) });
        }
    }
    export async function POST({ url }) {
        // Uncaught: the request ends with the error.
        await fetch(url.searchParams.get("url"));
        return new Response("unreachable");
    }
"#;

async fn probe_iso(env: &Env, network: &[&str], limits: Limits) -> IsolateHandle {
    let (dir, hash) = function_artifact(PROBE, &[("GET", "/p"), ("POST", "/p")], network);
    env.rt
        .create_isolate(spec(&dir, &hash, limits))
        .await
        .unwrap()
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

async fn probe(iso: &IsolateHandle, target: &str) -> serde_json::Value {
    let out = iso
        .dispatch(
            ctx("req_fetch_probe1"),
            get(&format!("/p?url={}", enc(target))),
        )
        .await;
    assert_eq!(out.response.status(), 200, "{:?}", out.response.body());
    body_json(&out.response)
}

fn blocked(v: &serde_json::Value, reason: &str) {
    assert_eq!(v["ok"], false, "{v}");
    assert_eq!(v["code"], "RENOX_FETCH_BLOCKED", "{v}");
    assert_eq!(v["details"]["reason"], reason, "{v}");
}

#[tokio::test]
async fn allowlisted_host_with_public_address_is_fetched() {
    let env = env().await;
    let iso = probe_iso(&env, &["http://api.example.com"], Limits::FREE).await;
    let v = probe(&iso, "http://api.example.com/echo").await;
    assert_eq!(v["ok"], true, "{v}");
    let echo: serde_json::Value = serde_json::from_str(v["body"].as_str().unwrap()).unwrap();
    // The original Host is sent to the vetted address.
    assert_eq!(echo["host"], "api.example.com");
    assert_eq!(echo["authorization"], "Bearer t0k");
    // Meter: bytes on the wire are counted.
    let out = iso
        .dispatch(
            ctx("req_fetch_meter1"),
            get(&format!("/p?url={}", enc("http://api.example.com/hello"))),
        )
        .await;
    assert!(out.meter.fetch_sent_bytes > 50, "{:?}", out.meter);
    assert!(out.meter.fetch_received_bytes > 50, "{:?}", out.meter);
    assert_eq!(out.meter.fetch_blocked, 0);
}

/// `docs/24-threat-model.md` section B, SSRF row; `docs/23-failure-modes.md`,
/// "`fetch` to blocked destination": the metadata endpoint is blocked,
/// listed or not.
#[tokio::test]
async fn metadata_endpoint_is_blocked() {
    let env = env().await;
    let iso = probe_iso(&env, &["http://api.example.com"], Limits::FREE).await;
    blocked(
        &probe(&iso, "http://169.254.169.254/latest/meta-data/").await,
        "not_allowlisted",
    );
    let iso = probe_iso(
        &env,
        &["http://169.254.169.254", "http://metadata.example.com"],
        Limits::FREE,
    )
    .await;
    blocked(
        &probe(&iso, "http://169.254.169.254/latest/meta-data/").await,
        "blocked_address",
    );
    blocked(
        &probe(&iso, "http://metadata.example.com/").await,
        "blocked_address",
    );
}

/// `localhost` is blocked even when listed.
#[tokio::test]
async fn localhost_is_blocked_even_if_listed() {
    let env = env().await;
    let port = env.server.addr.port();
    let iso = probe_iso(
        &env,
        &[
            &format!("http://localhost:{port}"),
            &format!("http://127.0.0.1:{port}"),
        ],
        Limits::FREE,
    )
    .await;
    blocked(
        &probe(&iso, &format!("http://localhost:{port}/hello")).await,
        "blocked_address",
    );
    blocked(
        &probe(&iso, &format!("http://127.0.0.1:{port}/hello")).await,
        "blocked_address",
    );
    assert!(
        env.server.seen().is_empty(),
        "the server must never be reached"
    );
}

/// An allowlisted host that resolves to a private address is blocked after
/// DNS (`blocked_address`); so is one with any private address among public ones.
#[tokio::test]
async fn allowlisted_host_resolving_to_private_address_is_blocked() {
    let env = env().await;
    let iso = probe_iso(
        &env,
        &["http://private.example.com", "http://mixed.example.com"],
        Limits::FREE,
    )
    .await;
    blocked(
        &probe(&iso, "http://private.example.com/hello").await,
        "blocked_address",
    );
    blocked(
        &probe(&iso, "http://mixed.example.com/hello").await,
        "blocked_address",
    );
    assert!(env.server.seen().is_empty());
    // Logged with host and reason, never the resolved address.
    let lines = env.sink.lines();
    let line = lines
        .iter()
        .find(|l| l.fields.get("host").and_then(|h| h.as_str()) == Some("private.example.com"))
        .expect("blocked fetch logged");
    assert_eq!(line.fields["reason"], "blocked_address");
    assert!(!format!("{:?}", lines).contains("10.0.0.5"));
}

/// A wildcard entry whose name resolves to `::ffff:127.0.0.1` is blocked.
#[tokio::test]
async fn v4_mapped_loopback_is_blocked() {
    let env = env().await;
    let iso = probe_iso(&env, &["http://*.example.com"], Limits::FREE).await;
    blocked(
        &probe(&iso, "http://mapped.example.com/hello").await,
        "blocked_address",
    );
}

/// Not on the allowlist: `not_allowlisted`. `*.example.com` matches
/// `a.b.example.com` but not `example.com`.
#[tokio::test]
async fn allowlist_matching() {
    let env = env().await;
    let iso = probe_iso(&env, &["http://*.example.com"], Limits::FREE).await;
    blocked(
        &probe(&iso, "http://other.test/hello").await,
        "not_allowlisted",
    );
    blocked(
        &probe(&iso, "http://example.com/hello").await,
        "not_allowlisted",
    );
    let v = probe(&iso, "http://a.b.example.com/hello").await;
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["body"], "hello");
    // https only unless declared with http://
    let iso = probe_iso(&env, &["api.example.com"], Limits::FREE).await;
    blocked(&probe(&iso, "http://api.example.com/hello").await, "scheme");
}

/// A public, allowlisted host that redirects to `http://127.0.0.1/` or to
/// a name resolving to a private address is blocked **at the redirect hop**.
#[tokio::test]
async fn redirect_to_loopback_is_blocked_at_the_hop() {
    let env = env().await;
    let port = env.server.addr.port();
    let iso = probe_iso(
        &env,
        &[
            "http://api.example.com",
            "http://private.example.com",
            &format!("http://127.0.0.1:{port}"),
        ],
        Limits::FREE,
    )
    .await;
    let to_loopback = format!(
        "http://api.example.com/redirect?to={}",
        enc(&format!("http://127.0.0.1:{port}/hello"))
    );
    let v = probe(&iso, &to_loopback).await;
    blocked(&v, "blocked_address");
    assert_eq!(v["details"]["hop"], 1);
    let to_private = format!(
        "http://api.example.com/redirect?to={}",
        enc("http://private.example.com/hello")
    );
    let v = probe(&iso, &to_private).await;
    blocked(&v, "blocked_address");
    assert_eq!(v["details"]["hop"], 1);
    // Only the first hop reached the server; the loopback target never did.
    assert!(
        env.server.seen().iter().all(|s| s.path == "/redirect"),
        "{:?}",
        env.server.seen()
    );
    // A followed redirect to an allowed host works, and the response says so.
    let ok = format!(
        "http://api.example.com/redirect?to={}",
        enc("http://api.example.com/hello")
    );
    let v = probe(&iso, &ok).await;
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["redirected"], true);
    assert_eq!(v["url"], "http://api.example.com/hello");
}

/// More than 5 redirect hops: `redirect_limit`.
#[tokio::test]
async fn redirect_limit() {
    let env = env().await;
    let iso = probe_iso(&env, &["http://api.example.com"], Limits::FREE).await;
    let mut url = "http://api.example.com/hello".to_string();
    for _ in 0..6 {
        url = format!("http://api.example.com/redirect?to={}", enc(&url));
    }
    blocked(&probe(&iso, &url).await, "redirect_limit");
}

/// `docs/23-failure-modes.md`, "`fetch` response too large": the egress
/// limit aborts a 10 MB download at the limit with `RENOX_FETCH_EGRESS_LIMIT`;
/// no byte beyond the limit is read from the socket.
#[tokio::test]
async fn egress_limit_aborts_a_large_download() {
    let env = env().await;
    let limits = Limits {
        egress_bytes: 1024 * 1024,
        ..Limits::FREE
    };
    let iso = probe_iso(&env, &["http://api.example.com"], limits).await;
    let out = iso
        .dispatch(
            ctx("req_fetch_egress1"),
            get(&format!(
                "/p?read=1&url={}",
                enc("http://api.example.com/big")
            )),
        )
        .await;
    let v = body_json(&out.response);
    assert_eq!(v["ok"], false, "{v}");
    assert_eq!(v["code"], "RENOX_FETCH_EGRESS_LIMIT", "{v}");
    assert_eq!(v["details"]["limitBytes"], 1024 * 1024);
    let total = out.meter.fetch_sent_bytes + out.meter.fetch_received_bytes;
    assert!(
        total <= 1024 * 1024 && total > 1024 * 1024 - 64 * 1024,
        "stopped at {total} bytes"
    );
}

/// `docs/23-failure-modes.md`, "`fetch` response too slow": a slow server
/// trips the request deadline; the request gets 504 and the pending fetch
/// rejects with `RENOX_DEADLINE`.
#[tokio::test]
async fn slow_server_trips_the_deadline() {
    let env = env().await;
    let src = r#"
        let seen = "pending";
        export async function GET({ url }) {
            try { await fetch(url.searchParams.get("url")); seen = "returned"; } catch (e) { seen = e.code; }
            return new Response("late");
        }
        export async function POST() {
            await new Promise((r) => setTimeout(r, 100));
            return Response.json({ seen });
        }
    "#;
    let (dir, hash) = function_artifact(
        src,
        &[("GET", "/s"), ("POST", "/s")],
        &["http://api.example.com"],
    );
    let iso = env
        .rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let started = Instant::now();
    let req_ctx = RequestCtx {
        request_id: "req_fetch_slow001".into(),
        deadline: Instant::now() + Duration::from_millis(300),
    };
    let out = iso
        .dispatch(
            req_ctx,
            get(&format!("/s?url={}", enc("http://api.example.com/slow"))),
        )
        .await;
    assert_eq!(out.response.status(), 504);
    assert_eq!(out.meter.status, MeterStatus::Timeout);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    let post = http::Request::builder()
        .method("POST")
        .uri("https://test.renox.app/s")
        .body(Bytes::new())
        .unwrap();
    let out = iso.dispatch(ctx("req_fetch_slow002"), post).await;
    assert_eq!(
        body_json(&out.response),
        serde_json::json!({ "seen": "RENOX_DEADLINE" })
    );
}

/// An uncaught blocked fetch ends the request with 500 `RENOX_INTERNAL`,
/// meter status `blocked_fetch`, and `fetch_blocked = 1`; ops outside a
/// request reject with `RENOX_NO_REQUEST`.
#[tokio::test]
async fn uncaught_blocked_fetch_is_metered() {
    let env = env().await;
    let iso = probe_iso(&env, &[], Limits::FREE).await;
    let post = http::Request::builder()
        .method("POST")
        .uri(format!(
            "https://test.renox.app/p?url={}",
            enc("https://api.example.com/")
        ))
        .body(Bytes::new())
        .unwrap();
    let out = iso.dispatch(ctx("req_fetch_uncau1"), post).await;
    assert_eq!(out.response.status(), 500);
    assert_eq!(out.meter.status, MeterStatus::BlockedFetch);
    assert_eq!(out.meter.fetch_blocked, 1);

    let src = r#"
        let topLevel = "pending";
        try { await fetch("https://api.example.com/"); topLevel = "worked"; } catch (e) { topLevel = e.code; }
        export const GET = () => Response.json({ topLevel });
    "#;
    let (dir, hash) = function_artifact(src, &[("GET", "/t")], &["api.example.com"]);
    let iso = env
        .rt
        .create_isolate(spec(&dir, &hash, Limits::FREE))
        .await
        .unwrap();
    let out = iso.dispatch(ctx("req_fetch_toplev1"), get("/t")).await;
    assert_eq!(
        body_json(&out.response),
        serde_json::json!({ "topLevel": "RENOX_NO_REQUEST" })
    );
}
