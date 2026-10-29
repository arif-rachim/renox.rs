//! Issue #285: the App MCP endpoint end to end in the cell (V8-linked)
//! (`docs/contracts/ops.md` 1.5.0 section 19; `docs/20-ai-agents-mcp.md`
//! sections 2 and 5). The fixture `auth` module's `verifyAgentToken` reads
//! `auth__agent_tokens`; `POST /auth/revoke` marks a token revoked and
//! emits `auth.agent_token_revoked`.
//!
//! Proves `docs/23-failure-modes.md` F5 "App MCP: tool call without the
//! Cedar action -> refused; metered" (`a_call_is_authorized_as_the_user`).

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use renox_cell::cell::LocalSecrets;
use renox_cell::manager::StaticTiers;
use renox_cell::pages::PlatformKey;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, MeterKind, MeterRecord, Sink, SinkError};
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{Runtime, RuntimeConfig};
use sha2::Digest;

static N: AtomicU64 = AtomicU64::new(0);
const SECRET: &str = "sk_live_7f3a9c2e5b1d8f6a4c0e";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-mcp-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn sha(s: &str) -> String {
    sha2::Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

const AUTH: &str = r#"
export async function verifyAgentToken(ctx, token) {
  const row = await ctx.db.queryOne("select user_id, scopes, revoked from auth__agent_tokens where token = ?", [token]);
  if (!row || row.revoked) return null;
  return { principal: { id: row.user_id, attrs: { org: "o_1" } }, scopes: JSON.parse(row.scopes), client: { name: "test-agent", model: "m1" } };
}
export async function oauthMetadata(ctx, issuer) {
  return { issuer, token_endpoint: `${issuer}/token`, code_challenge_methods_supported: ["S256"] };
}
"#;

const REVOKE: &str = r#"
export async function POST(ctx) {
  const token = ctx.url.searchParams.get("token");
  await ctx.db.execute("update auth__agent_tokens set revoked = 1 where token = ?", [token]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  await ctx.events.emit("auth.agent_token_revoked", { token_hash: hash });
  return Response.json({ ok: true });
}
"#;

fn tool(name: &str, run: &str, action: &str, confirm: bool) -> String {
    format!(
        "export default {{ name: {name:?}, description: \"t\", action: {action:?}, confirm: {confirm}, input: {{}}, async run(ctx) {{ {run} }} }};\n"
    )
}

const POLICIES: &str = r#"
permit (principal is Renox::User, action in [Renox::Action::"note.read", Renox::Action::"note.delete"], resource);
"#;

fn module_entry() -> serde_json::Value {
    let perms = serde_json::json!({ "tables": "auth__*", "network": [], "secrets": [], "slots": [], "hooks": [] });
    serde_json::json!({
        "name": "auth", "version": "1.0.0", "hash": "0".repeat(64), "source": "path:modules/auth",
        "mount": "/auth", "isolation": "shared", "dependencies": [], "config": {},
        "permissions": perms, "approved": perms,
        "exports": { "services": ["verifyAgentToken", "oauthMetadata"], "events": { "auth.agent_token_revoked": { "type": "object" } } },
    })
}

fn artifact(store: &Path, with_auth: bool) -> String {
    let tmp = scratch("artifact");
    let tools: Vec<(&str, String, &str, bool)> = vec![
        ("list_notes", "return await ctx.db.query('select text from app__notes order by text');".into(), "note.read", false),
        ("delete_notes", "await ctx.db.execute('delete from app__notes'); return { deleted: true, preview: ctx.tool.preview, client: ctx.tool.client.name };".into(), "note.delete", true),
        ("purge", "return 1;".into(), "note.purge", false),
        ("big_output", "return 'x'.repeat(300 * 1024);".into(), "note.read", false),
        ("leak", "return { key: ctx.secrets.API_KEY };".into(), "note.read", false),
        ("thrower", "throw new Error('failed with ' + ctx.secrets.API_KEY);".into(), "note.read", false),
    ];
    let mut code: Vec<(String, String)> = tools
        .iter()
        .map(|(n, run, a, c)| (format!("functions/tools/{n}"), tool(n, run, a, *c)))
        .collect();
    code.push((
        "functions/health".into(),
        "export const GET = () => new Response('ok');\n".into(),
    ));
    if with_auth {
        code.push(("modules/auth/services".into(), AUTH.into()));
        code.push(("modules/auth/functions/revoke".into(), REVOKE.into()));
    }
    for (id, src) in &code {
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let app_sql =
        "create table app__notes (text text);\ninsert into app__notes values ('a'), ('b');\n";
    let auth_sql = "create table auth__agent_tokens (token text primary key, user_id text, scopes text, revoked integer default 0);\n\
        insert into auth__agent_tokens (token, user_id, scopes) values ('tok_full', 'u_alice', '[\"tools:*\"]'), ('tok_limited', 'u_bob', '[\"tools:list_notes\"]'), ('tok_rate', 'u_carol', '[\"list_notes\"]');\n";
    let mut sums = serde_json::Map::new();
    std::fs::create_dir_all(tmp.join("migrations/app")).unwrap();
    std::fs::write(tmp.join("migrations/app/001_init.sql"), app_sql).unwrap();
    sums.insert("app/001_init.sql".into(), sha(app_sql).into());
    if with_auth {
        std::fs::create_dir_all(tmp.join("migrations/auth")).unwrap();
        std::fs::write(tmp.join("migrations/auth/001_init.sql"), auth_sql).unwrap();
        sums.insert("auth/001_init.sql".into(), sha(auth_sql).into());
    }
    std::fs::write(
        tmp.join("migrations/checksums.json"),
        serde_json::json!({ "version": 0, "files": sums }).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(tmp.join("policies/app")).unwrap();
    std::fs::write(tmp.join("policies/app/notes.cedar"), POLICIES).unwrap();
    let entry: BTreeMap<String, String> = code
        .iter()
        .map(|(id, _)| (id.clone(), format!("{id}.js")))
        .collect();
    let mut routes: Vec<serde_json::Value> = tools
        .iter()
        .map(|(n, _, a, c)| {
            serde_json::json!({ "kind": "tool", "name": n, "module": format!("functions/tools/{n}"), "description": "t",
                "input": { "type": "object", "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 50 } }, "additionalProperties": false },
                "action": a, "confirm": c })
        })
        .collect();
    routes.push(serde_json::json!({ "kind": "function", "method": "GET", "path": "/health", "module": "functions/health", "export": "GET" }));
    if with_auth {
        routes.push(serde_json::json!({ "kind": "function", "method": "POST", "path": "/auth/revoke", "module": "modules/auth/functions/revoke", "export": "POST" }));
    }
    let mut manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "notes", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": routes,
        "permissions": { "network": [], "secrets": ["API_KEY"] },
        "authz": { "actions": ["note.read", "note.delete", "note.purge"] },
    });
    if with_auth {
        manifest["modules"] = serde_json::json!([module_entry()]);
    }
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let hash = renox_runtime::manifest::content_hash(&tmp).unwrap();
    std::fs::rename(&tmp, store.join(&hash)).unwrap();
    hash
}

#[derive(Clone, Default)]
struct Records(Arc<Mutex<Vec<MeterRecord>>>);

impl Sink for Records {
    async fn write_batch(&self, batch: &MeterBatch) -> Result<(), SinkError> {
        self.0.lock().unwrap().extend(batch.records.iter().cloned());
        Ok(())
    }
}

struct Node {
    manager: CellManager,
    hash: String,
    records: Records,
    logs: Arc<MemoryLogSink>,
}

fn node(with_auth: bool) -> Node {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let data = scratch("data");
    let artifacts = scratch("artifacts");
    let hash = artifact(&artifacts, with_auth);
    std::fs::create_dir_all(data.join("t_mcp")).unwrap();
    std::fs::write(
        data.join("t_mcp/secrets.json"),
        serde_json::json!({ "API_KEY": SECRET }).to_string(),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            data.join("t_mcp/secrets.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let records = Records::default();
    let mut config = MeterConfig::new("t_mcp@test", "test", &data);
    config.flush_interval = Duration::from_millis(20);
    let meter = Meter::start(config, records.clone());
    let logs = Arc::new(MemoryLogSink::default());
    let manager = CellManager::new(
        Runtime::new(RuntimeConfig {
            log_sink: logs.clone(),
            ..RuntimeConfig::default()
        }),
        meter,
        ManagerConfig {
            data_dir: data.clone(),
            artifacts: Arc::new(LocalArtifactStore::new(&artifacts)),
            idle_timeout: Duration::from_secs(600),
            tiers: Tiers::default(),
            deployments: Arc::new(StaticTiers {
                default_tier: TierName::Free,
                tenant_tiers: BTreeMap::new(),
            }),
            secrets: Arc::new(LocalSecrets {
                data_dir: data.clone(),
            }),
            platform_key: PlatformKey::random(),
        },
    );
    Node {
        manager,
        hash,
        records,
        logs,
    }
}

struct Reply {
    status: u16,
    headers: http::HeaderMap,
    body: serde_json::Value,
}

impl Node {
    async fn send(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> Reply {
        let ctx = RequestCtx {
            tenant_id: "t_mcp".into(),
            deployment_hash: self.hash.clone(),
            request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let mut b = http::Request::builder()
            .method(method)
            .uri(format!("https://notes.renox.app{path}"))
            .header("host", "notes.renox.app");
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        let req = b
            .body(axum::body::Body::from(
                body.map(|v| v.to_string()).unwrap_or_default(),
            ))
            .unwrap();
        let res = self.manager.dispatch(ctx, req).await;
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            headers,
            body: serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        }
    }

    async fn rpc(&self, token: Option<&str>, method: &str, params: serde_json::Value) -> Reply {
        self.send("POST", "/mcp", token, Some(serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))).await
    }

    async fn call(&self, token: &str, tool: &str, args: serde_json::Value) -> Reply {
        self.rpc(
            Some(token),
            "tools/call",
            serde_json::json!({ "name": tool, "arguments": args }),
        )
        .await
    }
}

fn error_code(r: &Reply) -> &str {
    r.body["error"]["data"]["code"].as_str().unwrap_or_default()
}

/// initialize, and tools/list filtered by the token's scopes; no token or
/// an unknown one is 401 with the resource metadata URL.
#[tokio::test]
async fn list_is_filtered_by_scope_and_tokens_are_required() {
    let n = node(true);
    let init = n
        .rpc(Some("tok_full"), "initialize", serde_json::json!({}))
        .await;
    assert_eq!(init.body["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init.body["result"]["serverInfo"]["name"], "notes");
    let all = n
        .rpc(Some("tok_full"), "tools/list", serde_json::json!({}))
        .await;
    let names: Vec<&str> = all.body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 6, "{names:?}");
    let del = all.body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "delete_notes")
        .unwrap();
    assert_eq!(
        del["annotations"],
        serde_json::json!({ "readOnlyHint": false, "destructiveHint": true })
    );
    let some = n
        .rpc(Some("tok_limited"), "tools/list", serde_json::json!({}))
        .await;
    assert_eq!(some.body["result"]["tools"].as_array().unwrap().len(), 1);
    let scoped = n
        .call("tok_limited", "delete_notes", serde_json::json!({}))
        .await;
    assert_eq!(
        (scoped.status, error_code(&scoped)),
        (403, "RENOX_TOOL_SCOPE")
    );
    for token in [None, Some("tok_nope")] {
        let r = n.rpc(token, "tools/list", serde_json::json!({})).await;
        assert_eq!(r.status, 401);
        assert_eq!(
            r.headers["www-authenticate"],
            "Bearer resource_metadata=\"https://notes.renox.app/.well-known/oauth-protected-resource/mcp\""
        );
    }
    let meta = n
        .send(
            "GET",
            "/.well-known/oauth-protected-resource/mcp",
            None,
            None,
        )
        .await;
    assert_eq!(
        meta.body["authorization_servers"][0],
        "https://notes.renox.app/auth/oauth"
    );
    // The authorization server metadata (RFC 8414), at both locations.
    for path in [
        "/.well-known/oauth-authorization-server/auth/oauth",
        "/auth/oauth/.well-known/oauth-authorization-server",
    ] {
        let r = n.send("GET", path, None, None).await;
        assert_eq!(r.status, 200, "{path}");
        assert_eq!(r.body["issuer"], "https://notes.renox.app/auth/oauth");
        assert_eq!(
            r.body["token_endpoint"],
            "https://notes.renox.app/auth/oauth/token"
        );
    }
    assert_eq!(
        n.send(
            "GET",
            "/.well-known/oauth-authorization-server/other",
            None,
            None
        )
        .await
        .status,
        404
    );
    assert_eq!(
        n.send("GET", "/mcp", Some("tok_full"), None).await.status,
        405
    );
    let batch = n
        .send(
            "POST",
            "/mcp",
            Some("tok_full"),
            Some(serde_json::json!([{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }])),
        )
        .await;
    assert_eq!(batch.body["error"]["code"], -32600);
}

/// A call runs as the token's user: the policy allows `note.read` and has no
/// permit for `note.purge` (403, no record); an allowed call is metered as
/// `TOOL <name>`, kind `tool`.
#[tokio::test]
async fn a_call_is_authorized_as_the_user() {
    let n = node(true);
    let ok = n
        .call("tok_full", "list_notes", serde_json::json!({}))
        .await;
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert_eq!(
        ok.body["result"]["structuredContent"],
        serde_json::json!([{ "text": "a" }, { "text": "b" }])
    );
    assert_eq!(ok.body["result"]["_meta"]["untrusted"], true);
    assert_eq!(ok.body["result"]["isError"], false);
    let denied = n.call("tok_full", "purge", serde_json::json!({})).await;
    assert_eq!(
        (denied.status, error_code(&denied)),
        (403, "RENOX_FORBIDDEN")
    );
    let t0 = Instant::now();
    loop {
        let recs = n.records.0.lock().unwrap().clone();
        if let Some(r) = recs.iter().find(|r| r.route == "TOOL list_notes") {
            assert_eq!(r.kind, Some(MeterKind::Tool));
            assert_eq!(r.http_status, 200);
            assert!(r.authz_evals.is_some_and(|e| e >= 1), "{r:?}");
            assert!(
                !recs.iter().any(|r| r.route == "TOOL purge"),
                "a denied call never reached run"
            );
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(5), "no tool record");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Invalid input is 400 `RENOX_TOOL_INPUT` with the fields; the output cap
/// and a throw are `isError` results with fixed texts.
#[tokio::test]
async fn input_output_cap_and_failures() {
    let n = node(true);
    let bad = n
        .call(
            "tok_full",
            "list_notes",
            serde_json::json!({ "limit": 0, "extra": 1 }),
        )
        .await;
    assert_eq!((bad.status, error_code(&bad)), (400, "RENOX_TOOL_INPUT"));
    let fields: Vec<&str> = bad.body["error"]["data"]["details"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["field"].as_str().unwrap())
        .collect();
    assert!(fields.contains(&"/limit"), "{fields:?}");
    let big = n
        .call("tok_full", "big_output", serde_json::json!({}))
        .await;
    assert_eq!(big.body["result"]["isError"], true);
    assert_eq!(
        big.body["result"]["content"][0]["text"],
        "The tool output is too large."
    );
    let threw = n.call("tok_full", "thrower", serde_json::json!({})).await;
    assert_eq!(
        threw.body["result"]["content"][0]["text"],
        "The tool failed."
    );
}

/// The confirm flow: the preview runs in a rolled-back transaction and
/// answers a confirmation token; the confirmed call runs for real; a
/// replayed token and one for other arguments are 409.
#[tokio::test]
async fn the_confirm_flow() {
    let n = node(true);
    let preview = n
        .call("tok_full", "delete_notes", serde_json::json!({}))
        .await;
    let content = &preview.body["result"]["structuredContent"];
    assert_eq!(
        content["preview"],
        serde_json::json!({ "deleted": true, "preview": true, "client": "test-agent" }),
        "{}",
        preview.body
    );
    let token = content["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(content["confirmation"]["expires_at"].as_u64().is_some());
    let still = n
        .call("tok_full", "list_notes", serde_json::json!({}))
        .await;
    assert_eq!(
        still.body["result"]["structuredContent"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "the preview was rolled back"
    );
    let with = |args: serde_json::Value| serde_json::json!({ "name": "delete_notes", "arguments": args, "_meta": { "renox/confirmation": token } });
    let other = n
        .rpc(
            Some("tok_full"),
            "tools/call",
            with(serde_json::json!({ "limit": 3 })),
        )
        .await;
    assert_eq!(
        (other.status, error_code(&other)),
        (409, "RENOX_TOOL_CONFIRM")
    );
    let real = n
        .rpc(Some("tok_full"), "tools/call", with(serde_json::json!({})))
        .await;
    assert_eq!(
        real.body["result"]["structuredContent"]["preview"], false,
        "{}",
        real.body
    );
    let after = n
        .call("tok_full", "list_notes", serde_json::json!({}))
        .await;
    assert_eq!(
        after.body["result"]["structuredContent"],
        serde_json::json!([])
    );
    let replay = n
        .rpc(Some("tok_full"), "tools/call", with(serde_json::json!({})))
        .await;
    assert_eq!(
        (replay.status, error_code(&replay)),
        (409, "RENOX_TOOL_CONFIRM")
    );
}

/// 60 calls per minute per token: the 61st is 429 with Retry-After.
#[tokio::test]
async fn the_rate_limit() {
    let n = node(true);
    for i in 0..60 {
        let r = n
            .call("tok_rate", "list_notes", serde_json::json!({}))
            .await;
        assert_eq!(r.status, 200, "call {i}: {}", r.body);
    }
    let over = n
        .call("tok_rate", "list_notes", serde_json::json!({}))
        .await;
    assert_eq!(over.status, 429);
    assert!(over.headers.contains_key("retry-after"));
    // Another token is not affected.
    assert_eq!(
        n.call("tok_full", "list_notes", serde_json::json!({}))
            .await
            .status,
        200
    );
}

/// A revoked token is refused after the `auth.agent_token_revoked` event,
/// within one outbox round trip, not after the 60 s cache.
#[tokio::test]
async fn a_revoked_token_is_refused_after_the_event() {
    let n = node(true);
    assert_eq!(
        n.call("tok_full", "list_notes", serde_json::json!({}))
            .await
            .status,
        200
    );
    let r = n
        .send("POST", "/auth/revoke?token=tok_full", None, None)
        .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let t0 = Instant::now();
    loop {
        if n.call("tok_full", "list_notes", serde_json::json!({}))
            .await
            .status
            == 401
        {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "the revoked token was still accepted"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    eprintln!("revocation effective after {:?}", t0.elapsed());
}

/// No secret value in any output or log line (`docs/20` section 5).
#[tokio::test]
async fn no_secret_in_outputs_or_logs() {
    let n = node(true);
    let leak = n.call("tok_full", "leak", serde_json::json!({})).await;
    let threw = n.call("tok_full", "thrower", serde_json::json!({})).await;
    for r in [&leak, &threw] {
        assert!(!r.body.to_string().contains(SECRET), "{}", r.body);
    }
    assert_eq!(leak.body["result"]["isError"], false);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let logs = n.logs.lines();
    assert!(
        logs.iter().any(|l| l.message == "invocation threw"),
        "the throw was logged"
    );
    for l in logs {
        let text = format!("{} {}", l.message, serde_json::Value::Object(l.fields));
        assert!(
            !text.contains(SECRET),
            "a log line holds the secret: {text}"
        );
    }
}

/// Without the `auth` module there is no authorization server: 404.
#[tokio::test]
async fn without_auth_the_endpoint_is_404() {
    let n = node(false);
    assert_eq!(
        n.rpc(Some("tok_full"), "tools/list", serde_json::json!({}))
            .await
            .status,
        404
    );
    assert_eq!(
        n.send(
            "GET",
            "/.well-known/oauth-protected-resource/mcp",
            None,
            None
        )
        .await
        .status,
        404
    );
}
