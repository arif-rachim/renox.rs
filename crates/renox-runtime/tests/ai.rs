//! Issue #322: `ctx.ai` (`docs/contracts/ops.md` 1.7.0 section 23).
//! V8-linked.
//!
//! Direct mode against a stand-in of the Anthropic Messages API (the app's
//! own key, through `fetch` and its allowlist), a local tool run in the
//! isolate, gateway mode against a stand-in of the platform gateway, the
//! tokens on the meter, the quota, and the key never in a log line.
//! `docs/24-threat-model.md`, "AI gateway secret or quota abuse" and
//! "Prompt injection through tenant content reaching `ctx.ai`".

mod support;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use renox_runtime::ops::ai::{AiGateway, AiSlot, GatewayError};
use renox_runtime::ops::fetch::FetchConfig;
use renox_runtime::{Runtime, RuntimeConfig};
use support::{StaticResolver, body_json, ctx, get, spec, write_artifact};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const KEY: &str = "sk-ant-test-key-0123456789abcdef";
const PUBLIC: &str = "93.184.216.34";

/// The app: one question, with a local VAT tool when `?tool=1`.
const APP: &str = r#"
export async function GET(ctx) {
  const tool = ctx.url.searchParams.get("tool") === "1";
  try {
    const r = await ctx.ai.chat({
      system: "Answer briefly.",
      messages: [{ role: "user", content: "VAT on AED 100?" }],
      maxTokens: 200,
      tools: tool ? [{ name: "lookup_vat", description: "UAE VAT rate", input_schema: { type: "object" }, run: async () => ({ rate: 5 }) }] : undefined,
    });
    return Response.json({ ok: true, text: r.content.find((c) => c.type === "text")?.text ?? null, usage: r.usage, stop: r.stop_reason });
  } catch (e) {
    return Response.json({ ok: false, code: e.code ?? null, name: e.name, message: String(e.message) });
  }
}
"#;

/// A stand-in of `POST /v1/messages`: a tool_use first when tools are
/// offered, the text answer once a tool_result comes back.
/// (the `x-api-key` header, the body) of each request.
type Seen = Arc<Mutex<Vec<(Option<String>, String)>>>;

struct Provider {
    addr: SocketAddr,
    bodies: Seen,
}

async fn provider(status: u16) -> Provider {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let seen = bodies.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                return;
            };
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let head_end = loop {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let header = |name: &str| {
                    head.split("\r\n").find_map(|l| {
                        l.split_once(':')
                            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
                            .map(|(_, v)| v.trim().to_string())
                    })
                };
                let len: usize = header("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                while buf.len() - head_end < len {
                    let n = s.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body = String::from_utf8_lossy(&buf[head_end..]).to_string();
                seen.lock()
                    .unwrap()
                    .push((header("x-api-key"), body.clone()));
                let answer = if body.contains("tool_result") {
                    serde_json::json!({ "id": "msg_2", "model": "claude-opus-5-5", "content": [{ "type": "text", "text": "AED 5" }], "stop_reason": "end_turn", "usage": { "input_tokens": 20, "output_tokens": 7 } })
                } else if body.contains("lookup_vat") {
                    serde_json::json!({ "id": "msg_1", "model": "claude-opus-5-5", "content": [{ "type": "tool_use", "id": "tu_1", "name": "lookup_vat", "input": {} }], "stop_reason": "tool_use", "usage": { "input_tokens": 10, "output_tokens": 5 } })
                } else {
                    serde_json::json!({ "id": "msg_0", "model": "claude-opus-5-5", "content": [{ "type": "text", "text": "5 % VAT" }], "stop_reason": "end_turn", "usage": { "input_tokens": 12, "output_tokens": 4 } })
                };
                let text = answer.to_string();
                let reason = if status == 200 { "OK" } else { "Error" };
                let out = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                    text.len()
                );
                let _ = s.write_all(out.as_bytes()).await;
            });
        }
    });
    Provider { addr, bodies }
}

fn runtime(p: &Provider) -> (Runtime, Arc<renox_runtime::runtime::MemoryLogSink>) {
    let public: IpAddr = PUBLIC.parse().unwrap();
    let mut names: HashMap<String, Vec<IpAddr>> = HashMap::new();
    names.insert("api.anthropic.test".into(), vec![public]);
    let mut config = FetchConfig::with_resolver(Arc::new(StaticResolver(names)));
    config
        .connect_override
        .insert(SocketAddr::new(public, 80), p.addr);
    let sink = Arc::new(renox_runtime::runtime::MemoryLogSink::default());
    (
        Runtime::new(RuntimeConfig {
            log_sink: sink.clone(),
            fetch: config,
        }),
        sink,
    )
}

fn artifact(network: &[&str], secrets: &[&str], ai: Option<&str>) -> (std::path::PathBuf, String) {
    let mut manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "advisor", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": { "functions/f": "functions/f.js" } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/ask", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": network, "secrets": secrets },
    });
    if let Some(mode) = ai {
        manifest["ai"] = serde_json::json!({ "mode": mode });
    }
    let m = serde_json::to_vec_pretty(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", &m),
        ("code/functions/f.js", APP.as_bytes()),
    ])
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_mode_calls_the_provider_with_the_apps_key_runs_local_tools_and_meters_tokens() {
    let p = provider(200).await;
    // SAFETY: set before any isolate reads it; the tests of this file use the same value.
    unsafe { std::env::set_var("RENOX_TEST_AI_BASE", "http://api.anthropic.test") };
    let (rt, sink) = runtime(&p);
    let (dir, hash) = artifact(&["http://api.anthropic.test"], &["AI_ANTHROPIC_KEY"], None);
    let mut s = spec(&dir, &hash, renox_runtime::limits::Limits::FREE);
    s.secrets.insert("AI_ANTHROPIC_KEY".into(), KEY.into());
    let iso = rt.create_isolate(s).await.unwrap();
    let out = iso
        .dispatch(ctx("req_ai_direct_00001"), get("/ask?tool=1"))
        .await;
    let v = body_json(&out.response);
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["text"], "AED 5");
    assert_eq!(
        v["usage"],
        serde_json::json!({ "input_tokens": 30, "output_tokens": 12 })
    );
    assert_eq!(out.meter.ai_tokens_in, 30);
    assert_eq!(out.meter.ai_tokens_out, 12);
    let bodies = p.bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 2, "one tool round");
    assert!(
        bodies.iter().all(|(k, _)| k.as_deref() == Some(KEY)),
        "the app's key, in the provider's header"
    );
    assert!(
        bodies[1].1.contains("\"tool_result\"") && bodies[1].1.contains(r#"{\"rate\":5}"#),
        "the tool ran in the isolate"
    );
    assert!(bodies[0].1.contains("\"max_tokens\":200") && bodies[0].1.contains("claude-opus-5-5"));
    // Neither the key nor the conversation is ever logged.
    let logged = format!("{:?}", sink.lines());
    assert!(
        !logged.contains(KEY) && !logged.contains("VAT on AED"),
        "{logged}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_mode_needs_the_host_in_the_allowlist_and_a_failing_provider_is_unavailable() {
    let p = provider(500).await;
    unsafe { std::env::set_var("RENOX_TEST_AI_BASE", "http://api.anthropic.test") };
    let (rt, sink) = runtime(&p);
    // The key, but not the host: the fetch path refuses.
    let (dir, hash) = artifact(&[], &["AI_ANTHROPIC_KEY"], None);
    let mut s = spec(&dir, &hash, renox_runtime::limits::Limits::FREE);
    s.secrets.insert("AI_ANTHROPIC_KEY".into(), KEY.into());
    let iso = rt.create_isolate(s).await.unwrap();
    let v = body_json(
        &iso.dispatch(ctx("req_ai_blocked_0001"), get("/ask"))
            .await
            .response,
    );
    assert_eq!(v["code"], "RENOX_FETCH_BLOCKED", "{v}");
    let (dir, hash) = artifact(&["http://api.anthropic.test"], &["AI_ANTHROPIC_KEY"], None);
    let mut s = spec(&dir, &hash, renox_runtime::limits::Limits::FREE);
    s.secrets.insert("AI_ANTHROPIC_KEY".into(), KEY.into());
    let iso = rt.create_isolate(s).await.unwrap();
    let v = body_json(
        &iso.dispatch(ctx("req_ai_500_00000001"), get("/ask"))
            .await
            .response,
    );
    assert_eq!(v["code"], "RENOX_AI_UNAVAILABLE", "{v}");
    assert_eq!(v["name"], "AiUnavailableError");
    assert!(!format!("{:?}", sink.lines()).contains(KEY));
}

/// The platform gateway's stand-in: it sees the tenant, the app and the
/// request id; it can answer, or refuse past the quota.
struct Gateway {
    seen: Mutex<Vec<serde_json::Value>>,
    quota: bool,
}

impl AiGateway for Gateway {
    fn chat(
        &self,
        body: String,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<String, GatewayError>> + Send>> {
        self.seen
            .lock()
            .unwrap()
            .push(serde_json::from_str(&body).unwrap());
        let quota = self.quota;
        Box::pin(async move {
            if quota {
                return Err(GatewayError::Quota);
            }
            Ok(serde_json::json!({ "model": "claude-opus-5-5", "content": [{ "type": "text", "text": "via gateway" }], "stop_reason": "end_turn", "usage": { "input_tokens": 9, "output_tokens": 3 }, "cached": false }).to_string())
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_mode_goes_through_the_cell_meters_tokens_and_honours_the_quota() {
    let p = provider(200).await;
    let (rt, _) = runtime(&p);
    let (dir, hash) = artifact(&[], &[], None);
    let gw = Arc::new(Gateway {
        seen: Mutex::new(Vec::new()),
        quota: false,
    });
    let mut s = spec(&dir, &hash, renox_runtime::limits::Limits::FREE);
    s.ai = Some(AiSlot(gw.clone()));
    let iso = rt.create_isolate(s).await.unwrap();
    let out = iso.dispatch(ctx("req_ai_gateway_0001"), get("/ask")).await;
    let v = body_json(&out.response);
    assert_eq!(v["text"], "via gateway", "{v}");
    assert_eq!(out.meter.ai_tokens_in, 9);
    let seen = gw.seen.lock().unwrap().clone();
    assert_eq!(seen[0]["tenant_id"], "t_test");
    assert_eq!(seen[0]["app"], "advisor");
    assert_eq!(seen[0]["request_id"], "req_ai_gateway_0001");
    assert_eq!(seen[0]["model"], "default");
    assert!(
        p.bodies.lock().unwrap().is_empty(),
        "gateway mode never calls a provider from the isolate"
    );
    // Past the quota.
    let (dir, hash) = artifact(&[], &[], Some("gateway"));
    let mut s = spec(&dir, &hash, renox_runtime::limits::Limits::FREE);
    s.ai = Some(AiSlot(Arc::new(Gateway {
        seen: Mutex::new(Vec::new()),
        quota: true,
    })));
    let iso = rt.create_isolate(s).await.unwrap();
    let v = body_json(
        &iso.dispatch(ctx("req_ai_quota_000001"), get("/ask"))
            .await
            .response,
    );
    assert_eq!(v["code"], "RENOX_AI_QUOTA", "{v}");
    assert_eq!(v["name"], "AiQuotaError");
    // No gateway on this node (local mode).
    let (dir, hash) = artifact(&[], &[], None);
    let iso = rt
        .create_isolate(spec(&dir, &hash, renox_runtime::limits::Limits::FREE))
        .await
        .unwrap();
    let v = body_json(
        &iso.dispatch(ctx("req_ai_nogw_0000001"), get("/ask"))
            .await
            .response,
    );
    assert_eq!(v["code"], "RENOX_AI_UNAVAILABLE", "{v}");
}
