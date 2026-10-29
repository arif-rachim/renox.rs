//! Issue #164, ADR D23: an internal tenant (the dashboard, #57) reaches the
//! control API at its public hostname with a scoped tenant token, through
//! the same `fetch` rules as every tenant; every tenant, the dashboard
//! included, is refused the control plane's node-facing addresses with
//! `RENOX_FETCH_BLOCKED`.
//!
//! Names resolve through a fake resolver: `api.renox.test` (the public API)
//! to a public address, `nodes.renox.test` (the node-facing listener) to a
//! public address the node lists in `fetch_blocked_addresses`, and
//! `control.renox.internal` to a private address. The `test-hooks` connect
//! override maps **both** public addresses to one local TLS server, so a
//! refusal can only come from the policy: without it the node-facing request
//! would be answered.
#![cfg(feature = "v8")]

mod support;

use std::collections::{BTreeMap, HashMap};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use renox_runtime::IsolateHandle;
use renox_runtime::limits::Limits;
use renox_runtime::ops::fetch::FetchConfig;
use renox_runtime::ops::net_policy::ExtraBlocked;
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{Runtime, RuntimeConfig};
use support::http_server::{API_TOKEN, TestServer};
use support::*;

/// The public API edge.
const PUBLIC_API: &str = "93.184.216.34";
/// The control plane's node-facing listener: public, but listed by the node.
const NODE_FACING: &str = "93.184.216.40";

struct Env {
    rt: Runtime,
    sink: Arc<MemoryLogSink>,
    server: TestServer,
}

async fn env() -> Env {
    let (server, cert) =
        support::http_server::start_tls(&["api.renox.test", "nodes.renox.test"]).await;
    let public: IpAddr = PUBLIC_API.parse().unwrap();
    let node_facing: IpAddr = NODE_FACING.parse().unwrap();
    let names: HashMap<String, Vec<IpAddr>> = HashMap::from([
        ("api.renox.test".into(), vec![public]),
        ("nodes.renox.test".into(), vec![node_facing]),
        (
            "control.renox.internal".into(),
            vec!["10.0.0.7".parse().unwrap()],
        ),
    ]);
    let mut config = FetchConfig::with_resolver(Arc::new(StaticResolver(names)));
    // What `worker.toml` `fetch_blocked_addresses` holds (ADR D23): the
    // node-facing address, written in mapped form to show the form does
    // not matter. The public API address is not listed.
    config.extra_blocked = ExtraBlocked(vec!["::ffff:93.184.216.40".parse().unwrap()]);
    config.extra_root_certs.push(cert);
    config
        .connect_override
        .insert(SocketAddr::new(public, 443), server.addr);
    config
        .connect_override
        .insert(SocketAddr::new(node_facing, 443), server.addr);
    let sink = Arc::new(MemoryLogSink::default());
    let rt = Runtime::new(RuntimeConfig {
        log_sink: sink.clone(),
        fetch: config,
    });
    Env { rt, sink, server }
}

/// Fetches `?url=`, with `Authorization: Bearer <secrets.CONTROL_API_TOKEN>`
/// when the tenant holds that secret, and reports the outcome as JSON.
const PROBE: &str = r#"
    export async function GET({ url, secrets }) {
        const target = url.searchParams.get("url");
        const headers = {};
        if (secrets.CONTROL_API_TOKEN) headers.authorization = `Bearer ${secrets.CONTROL_API_TOKEN}`;
        try {
            const r = await fetch(target, { headers });
            return Response.json({ ok: true, status: r.status, body: await r.text() });
        } catch (e) {
            return Response.json({ ok: false, code: e.code ?? null, details: e.details ?? null, message: String(e.message) });
        }
    }
"#;

/// A tenant with `network` in its manifest and `token` as its
/// `CONTROL_API_TOKEN` secret.
async fn tenant(
    env: &Env,
    tenant_id: &str,
    network: &[&str],
    token: Option<&str>,
) -> IsolateHandle {
    let manifest = serde_json::json!({
        "artifact": { "version": 0 },
        "app": { "name": "test", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": { "functions/f": "functions/f.js" } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/p", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": network, "secrets": ["CONTROL_API_TOKEN"] }
    });
    let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
    let (dir, hash) = write_artifact(&[
        ("manifest.json", &manifest),
        ("code/functions/f.js", PROBE.as_bytes()),
    ]);
    let mut s = spec(&dir, &hash, Limits::FREE);
    s.tenant_id = tenant_id.into();
    if let Some(t) = token {
        s.secrets = BTreeMap::from([("CONTROL_API_TOKEN".to_string(), t.to_string())]);
    }
    env.rt.create_isolate(s).await.unwrap()
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
            ctx("req_internal_api1"),
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

const NODE_ROUTES: &str = "https://nodes.renox.test/v1/nodes/node-1/routes";
const PRIVATE_ROUTES: &str = "https://control.renox.internal/v1/nodes/node-1/routes";
const APPS: &str = "https://api.renox.test/v1/apps";

/// `docs/24-threat-model.md` B, "SSRF to metadata, loopback, private
/// ranges"; `docs/23-failure-modes.md`, "`fetch` to blocked destination":
/// a normal tenant gets `RENOX_FETCH_BLOCKED` for the control plane, even
/// when it lists the control plane's hosts in its manifest.
#[tokio::test]
async fn a_normal_tenant_is_refused_the_control_plane() {
    let env = env().await;
    let plain = tenant(&env, "t_normal", &[], None).await;
    for target in [NODE_ROUTES, PRIVATE_ROUTES, APPS] {
        blocked(&probe(&plain, target).await, "not_allowlisted");
    }
    let listing = tenant(
        &env,
        "t_listing",
        &["nodes.renox.test", "control.renox.internal"],
        None,
    )
    .await;
    for target in [NODE_ROUTES, PRIVATE_ROUTES] {
        let v = probe(&listing, target).await;
        blocked(&v, "blocked_address");
        // The refusal names the host, never a resolved address.
        assert!(!v.to_string().contains(NODE_FACING), "{v}");
        assert!(!v.to_string().contains("10.0.0.7"), "{v}");
    }
    assert!(
        env.server.seen().is_empty(),
        "no request left the node: {:?}",
        env.server.seen()
    );
}

/// ADR D23: the dashboard tenant reaches the public API with its scoped
/// token, as any internet client does; the API's own token check is the
/// fence (no token, 401).
#[tokio::test]
async fn the_dashboard_tenant_reaches_the_public_api_with_a_scoped_token() {
    let env = env().await;
    let dashboard = tenant(&env, "t_dashboard", &["api.renox.test"], Some(API_TOKEN)).await;
    let v = probe(&dashboard, APPS).await;
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["status"], 200, "{v}");
    let apps: serde_json::Value = serde_json::from_str(v["body"].as_str().unwrap()).unwrap();
    assert_eq!(apps["apps"][0]["name"], "shop", "{apps}");
    let seen = env.server.seen();
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert_eq!(seen[0].host, "api.renox.test");
    assert_eq!(seen[0].path, "/v1/apps");
    assert_eq!(
        seen[0].authorization.as_deref(),
        Some(format!("Bearer {API_TOKEN}").as_str())
    );

    // Same manifest, no token: the request goes out and the API refuses it.
    let tokenless = tenant(&env, "t_tokenless", &["api.renox.test"], None).await;
    let v = probe(&tokenless, APPS).await;
    assert_eq!(v["status"], 401, "{v}");

    // The token never reaches the tenant log sink.
    for line in env.sink.lines() {
        assert!(!format!("{line:?}").contains(API_TOKEN), "{line:?}");
    }
}

/// ADR D23, "no exemption": being the dashboard opens nothing else. It is
/// refused the node-facing listener directly, even when it lists it, and
/// through a redirect from the public API.
#[tokio::test]
async fn the_dashboard_tenant_is_refused_the_node_facing_control_plane() {
    let env = env().await;
    let dashboard = tenant(&env, "t_dashboard", &["api.renox.test"], Some(API_TOKEN)).await;
    blocked(&probe(&dashboard, NODE_ROUTES).await, "not_allowlisted");

    let misconfigured = tenant(
        &env,
        "t_dashboard_wide",
        &["api.renox.test", "nodes.renox.test"],
        Some(API_TOKEN),
    )
    .await;
    blocked(&probe(&misconfigured, NODE_ROUTES).await, "blocked_address");
    let bounce = format!(
        "https://api.renox.test/redirect?status=307&to={}",
        enc(NODE_ROUTES)
    );
    blocked(&probe(&misconfigured, &bounce).await, "blocked_address");
    let seen = env.server.seen();
    assert!(
        seen.iter().all(|s| s.host == "api.renox.test"),
        "only the public API was reached: {seen:?}"
    );
}
