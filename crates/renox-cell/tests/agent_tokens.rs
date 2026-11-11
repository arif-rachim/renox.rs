//! Issue #698: `POST /nodes/{node}/tenants/{tenant}/apps/{app}/agent-tokens`
//! on the node listener (`nodeMintAgentToken`, `docs/contracts/deploy-api.md`
//! 0.9 section 15; `docs/20-ai-agents-mcp.md` section 1b, "The bridge"). The
//! node runs the app's `auth.mintAgentToken` as the platform in the cell of
//! the app's active deployment and answers `agent_token_minted`; the control
//! plane then calls the app's own `/mcp` with the token like any agent.
//!
//! The fixture `auth` module does what `modules/auth` does at the edges the
//! cell sees: `mintAgentToken` refuses any principal but
//! `Renox::System::"renox"` and answers null for no (verified) user;
//! `verifyAgentToken` answers the token's `expires_at`. What the real module
//! decides (verified, the row, the grant) is `modules/auth/tests/agents.test.ts`.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use renox_cell::cell::LocalSecrets;
use renox_cell::control::node_listener::{CallbackToken, NodeListener, mint_scope_ok};
use renox_cell::manager::{DeploymentLookup, DeploymentMeta};
use renox_cell::pages::PlatformKey;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, Sink, SinkError};
use renox_runtime::runtime::MemoryLogSink;
use renox_runtime::{Runtime, RuntimeConfig};
use serde_json::{Value, json};
use sha2::Digest;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

static N: AtomicU64 = AtomicU64::new(0);
const CALLBACK: &str = "renox_cb_abcdefghijklmnopqrstuvwxyz234567";
const NODE: &str = "node-dxb-01";
const TENANT: &str = "t_coolair";
const APP: &str = "coolair";
const OTHER_TENANT: &str = "t_other";
const OTHER_APP: &str = "otherapp";
const PLAIN_APP: &str = "plain";
const GRANT: &str = "tok_01JBQ40000000000000000AB";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-agt-{}-{name}-{}",
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
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");
export async function verifyAgentToken(ctx, token) {
  const row = await ctx.db.queryOne("select user_id, scopes, client_name, grant_id, expires_at from auth__agent_tokens where token = ?", [token]);
  if (!row || row.expires_at <= Date.now()) return null;
  return { principal: { id: row.user_id, attrs: {}, roles: [] }, scopes: JSON.parse(row.scopes), client: { name: row.client_name, grant_id: row.grant_id }, expires_at: row.expires_at };
}
export async function mintAgentToken(ctx, input) {
  const p = ctx.principal;
  if (!p || p.kind !== "system" || p.id !== "renox") {
    const e = new Error("Only the platform may mint an agent token.");
    e.code = "AUTH_PLATFORM_ONLY";
    throw e;
  }
  const u = await ctx.db.queryOne("select id from auth__users where email = ? and verified = 1", [input.email]);
  if (!u) return null;
  const token = "renox_agt_" + hex(32);
  const expires_at = Date.now() + Math.min(input.ttl_seconds, 300) * 1000;
  await ctx.db.execute("insert into auth__agent_tokens (token, user_id, scopes, client_name, grant_id, expires_at) values (?, ?, ?, ?, ?, ?)", [token, u.id, JSON.stringify(input.scopes), input.client_name, input.grant_id, expires_at]);
  return { token, expires_at };
}
"#;

/// `POST /auth/expire?token=..&ms=..`: the token expires `ms` from now.
const EXPIRE: &str = r#"
export async function POST(ctx) {
  const q = ctx.url.searchParams;
  await ctx.db.execute("update auth__agent_tokens set expires_at = ? where token = ?", [Date.now() + Number(q.get("ms")), q.get("token")]);
  return Response.json({ ok: true });
}
"#;

/// Tenant code calling the service: refused, whoever is signed in.
const MINT_FROM_ROUTE: &str = r#"
export async function POST(ctx) {
  try {
    const r = await ctx.services.auth.mintAgentToken({ email: "owner@coolair.ae", scopes: ["tools:list_notes"], ttl_seconds: 300, client_name: "x", grant_id: "g" });
    return Response.json({ minted: r });
  } catch (e) {
    return Response.json({ refused: true, message: String(e?.message ?? e) });
  }
}
"#;

fn tool(name: &str, run: &str, action: &str) -> String {
    format!(
        "export default {{ name: {name:?}, description: \"t\", action: {action:?}, confirm: false, input: {{}}, async run(ctx) {{ {run} }} }};\n"
    )
}

const POLICIES: &str = r#"
permit (principal is Renox::User, action in [Renox::Action::"note.read", Renox::Action::"note.delete"], resource);
"#;

fn artifact(store: &Path, app: &str, with_auth: bool) -> String {
    let tmp = scratch("artifact");
    let tools = [
        (
            "list_notes",
            "return await ctx.db.query('select text from app__notes order by text');",
            "note.read",
        ),
        (
            "delete_notes",
            "await ctx.db.execute('delete from app__notes'); return { deleted: true };",
            "note.delete",
        ),
    ];
    let mut code: Vec<(String, String)> = tools
        .iter()
        .map(|(n, run, a)| (format!("functions/tools/{n}"), tool(n, run, a)))
        .collect();
    code.push(("functions/mint".into(), MINT_FROM_ROUTE.into()));
    if with_auth {
        code.push(("modules/auth/services".into(), AUTH.into()));
        code.push(("modules/auth/functions/expire".into(), EXPIRE.into()));
    }
    for (id, src) in &code {
        let p = tmp.join("code").join(format!("{id}.js"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let app_sql =
        "create table app__notes (text text);\ninsert into app__notes values ('a'), ('b');\n";
    let auth_sql = "create table auth__users (id text primary key, email text, verified integer);\n\
        create table auth__agent_tokens (token text primary key, user_id text, scopes text, client_name text, grant_id text, expires_at integer);\n\
        insert into auth__users values ('u_owner', 'owner@coolair.ae', 1), ('u_pending', 'pending@coolair.ae', 0);\n";
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
        json!({ "version": 0, "files": sums }).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(tmp.join("policies/app")).unwrap();
    std::fs::write(tmp.join("policies/app/notes.cedar"), POLICIES).unwrap();
    let entry: BTreeMap<String, String> = code
        .iter()
        .map(|(id, _)| (id.clone(), format!("{id}.js")))
        .collect();
    let mut routes: Vec<Value> = tools
        .iter()
        .map(|(n, _, a)| {
            json!({ "kind": "tool", "name": n, "module": format!("functions/tools/{n}"), "description": "t",
                "input": { "type": "object", "properties": {}, "additionalProperties": false },
                "action": a, "confirm": false })
        })
        .collect();
    routes.push(json!({ "kind": "function", "method": "POST", "path": "/mint", "module": "functions/mint", "export": "POST" }));
    if with_auth {
        routes.push(json!({ "kind": "function", "method": "POST", "path": "/auth/expire", "module": "modules/auth/functions/expire", "export": "POST" }));
    }
    let mut manifest = json!({
        "artifact": { "version": 1 },
        "app": { "name": app, "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": routes,
        "permissions": { "network": [], "secrets": [] },
        "authz": { "actions": ["note.read", "note.delete"] },
    });
    if with_auth {
        let perms =
            json!({ "tables": "auth__*", "network": [], "secrets": [], "slots": [], "hooks": [] });
        manifest["modules"] = json!([{
            "name": "auth", "version": "1.0.0", "hash": "0".repeat(64), "source": "path:modules/auth",
            "mount": "/auth", "isolation": "shared", "dependencies": [], "config": {},
            "permissions": perms, "approved": perms,
            "exports": { "services": ["verifyAgentToken", "mintAgentToken"], "events": {} },
        }]);
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

/// The node's route entries as the manager sees them: `(tenant, app)` -> the
/// active deployment's hash on this node.
struct Apps(BTreeMap<(String, String), String>);

impl DeploymentLookup for Apps {
    fn lookup(&self, tenant_id: &str, deployment_hash: &str) -> DeploymentMeta {
        let app = self
            .0
            .iter()
            .find(|((t, _), h)| t == tenant_id && *h == deployment_hash)
            .map(|((_, a), _)| a.clone());
        DeploymentMeta {
            tier: TierName::Free,
            app,
            secrets_version: 0,
            database: None,
        }
    }

    fn active_deployment(&self, tenant_id: &str, app: &str) -> Option<String> {
        self.0
            .get(&(tenant_id.to_string(), app.to_string()))
            .cloned()
    }
}

#[derive(Clone, Default)]
struct NoSink;

impl Sink for NoSink {
    async fn write_batch(&self, _batch: &MeterBatch) -> Result<(), SinkError> {
        Ok(())
    }
}

struct Node {
    manager: CellManager,
    hash: String,
    plain: String,
    logs: Arc<MemoryLogSink>,
    addr: SocketAddr,
}

async fn node() -> Node {
    let data = scratch("data");
    let artifacts = scratch("artifacts");
    let hash = artifact(&artifacts, APP, true);
    let plain = artifact(&artifacts, PLAIN_APP, false);
    std::fs::create_dir_all(data.join(TENANT)).unwrap();
    std::fs::create_dir_all(data.join(OTHER_TENANT)).unwrap();
    let mut config = MeterConfig::new("t_agt@test", "test", &data);
    config.flush_interval = Duration::from_millis(20);
    let meter = Meter::start(config, NoSink);
    let logs = Arc::new(MemoryLogSink::default());
    let mut apps = BTreeMap::new();
    apps.insert((TENANT.to_string(), APP.to_string()), hash.clone());
    apps.insert((TENANT.to_string(), PLAIN_APP.to_string()), plain.clone());
    // Another tenant's app on the same node.
    apps.insert(
        (OTHER_TENANT.to_string(), OTHER_APP.to_string()),
        hash.clone(),
    );
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
            deployments: Arc::new(Apps(apps)),
            secrets: Arc::new(LocalSecrets {
                data_dir: data.clone(),
            }),
            platform_key: PlatformKey::random(),
        },
    );
    let token = Arc::new(CallbackToken::default());
    token.set(Some(CALLBACK.into()));
    let listener = Arc::new(NodeListener {
        node_id: NODE.into(),
        token,
        replication: None,
        manager: manager.clone(),
        microvm_hook: None,
    });
    let (addr, _task) = listener
        .serve("127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    Node {
        manager,
        hash,
        plain,
        logs,
        addr,
    }
}

struct Answer {
    status: u16,
    body: Value,
    raw: String,
}

async fn post(addr: SocketAddr, path: &str, auth: Option<&str>, body: &Value) -> Answer {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = auth.map_or(String::new(), |a| format!("Authorization: {a}\r\n"));
    let text = body.to_string();
    s.write_all(
        format!(
            "POST {path} HTTP/1.1\r\nHost: node\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
            text.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.unwrap();
    let raw = String::from_utf8_lossy(&buf).to_string();
    let split = raw.find("\r\n\r\n").unwrap();
    let status = raw.split(' ').nth(1).unwrap().parse().unwrap();
    Answer {
        status,
        body: serde_json::from_str(&raw[split + 4..]).unwrap_or(Value::Null),
        raw,
    }
}

fn bearer() -> String {
    format!("Bearer {CALLBACK}")
}

fn path(tenant: &str, app: &str) -> String {
    format!("/nodes/{NODE}/tenants/{tenant}/apps/{app}/agent-tokens")
}

fn request(tenant: &str, app: &str, email: &str, scopes: &[&str], ttl: u64) -> Value {
    json!({
        "type": "agent_token_request", "schema_version": 0, "tenant_id": tenant, "app": app,
        "email": email, "scopes": scopes, "ttl_seconds": ttl,
        "client_name": "Renoxium connector", "grant_id": GRANT,
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

impl Node {
    async fn mint(&self, scopes: &[&str], ttl: u64) -> Answer {
        post(
            self.addr,
            &path(TENANT, APP),
            Some(&bearer()),
            &request(TENANT, APP, "owner@coolair.ae", scopes, ttl),
        )
        .await
    }

    /// One request to the app, as the gateway hands it to the cell.
    async fn app(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let ctx = RequestCtx {
            tenant_id: TENANT.into(),
            deployment_hash: self.hash.clone(),
            request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let mut b = http::Request::builder()
            .method("POST")
            .uri(format!("https://{APP}.renoxium.app{path}"))
            .header("host", format!("{APP}.renoxium.app"))
            .header("content-type", "application/json");
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        let req = b.body(axum::body::Body::from(body.to_string())).unwrap();
        let res = self.manager.dispatch(ctx, req).await;
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn call(&self, token: &str, tool: &str) -> (u16, Value) {
        self.app(
            "/mcp",
            Some(token),
            json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": {} } }),
        )
        .await
    }

    fn logs_text(&self) -> String {
        self.logs
            .lines()
            .iter()
            .map(|l| format!("{l:?}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn reason(a: &Answer) -> (&str, &str) {
    let d = &a.body["error"]["details"][0];
    (
        d["field"].as_str().unwrap_or_default(),
        d["reason"].as_str().unwrap_or_default(),
    )
}

/// The minted token is an `agent_token_minted` of at most 300 s; on the
/// app's `/mcp` it works for its named tool only (another tool is 403
/// `RENOX_TOOL_SCOPE`), and the answer is `no-store`.
#[tokio::test]
async fn a_minted_token_works_for_its_tool_only() {
    let n = node().await;
    let before = now_ms();
    let a = n.mint(&["tools:list_notes"], 300).await;
    assert_eq!(a.status, 200, "{}", a.raw);
    assert!(
        a.raw
            .to_ascii_lowercase()
            .contains("cache-control: no-store")
    );
    let token = a.body["token"].as_str().unwrap().to_string();
    assert!(
        token.starts_with("renox_agt_") && token.len() == 10 + 64,
        "{token}"
    );
    assert_eq!(a.body["type"], "agent_token_minted");
    assert_eq!(a.body["schema_version"], 0);
    assert_eq!(a.body["node_id"], NODE);
    assert_eq!(a.body["tenant_id"], TENANT);
    assert_eq!(a.body["app"], APP);
    let expires = a.body["expires_at"].as_u64().unwrap();
    assert!(
        expires > before && expires <= now_ms() + 300_000,
        "{expires}"
    );
    let (status, ok) = n.call(&token, "list_notes").await;
    assert_eq!(status, 200, "{ok}");
    assert_eq!(ok["result"]["isError"], false, "{ok}");
    assert_eq!(
        ok["result"]["structuredContent"],
        json!([{ "text": "a" }, { "text": "b" }])
    );
    assert_eq!(ok["result"]["_meta"]["untrusted"], true);
    let (status, other) = n.call(&token, "delete_notes").await;
    assert_eq!(
        (status, other["error"]["data"]["code"].as_str()),
        (403, Some("RENOX_TOOL_SCOPE")),
        "{other}"
    );
    // Nothing was deleted, and the token is in no tenant log line.
    let (_, again) = n.call(&token, "list_notes").await;
    assert_eq!(
        again["result"]["structuredContent"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(!n.logs_text().contains(&token));
}

/// Past `expires_at` the token stops working, also when the cell had cached
/// it (its cache keeps a token no longer than `auth` said it lives).
#[tokio::test]
async fn the_token_stops_at_expires_at_even_when_cached() {
    let n = node().await;
    let a = n.mint(&["tools:list_notes"], 300).await;
    let token = a.body["token"].as_str().unwrap().to_string();
    let (status, _) = n
        .app(
            &format!("/auth/expire?token={token}&ms=1500"),
            None,
            json!({}),
        )
        .await;
    assert_eq!(status, 200);
    // Verified now (expiring in 1.5 s) and cached.
    assert_eq!(n.call(&token, "list_notes").await.0, 200);
    assert_eq!(n.call(&token, "list_notes").await.0, 200);
    tokio::time::sleep(Duration::from_millis(1800)).await;
    let (status, gone) = n.call(&token, "list_notes").await;
    assert_eq!(status, 401, "{gone}");
}

/// 400: a scope that is not `tools:<name>` (`tools:*` included), a ttl
/// above 300 s or below 30 s, a body of another tenant or app than the
/// path, or not an `agent_token_request`. Nothing is minted.
#[tokio::test]
async fn bad_requests_are_400() {
    let n = node().await;
    let owner = "owner@coolair.ae";
    let cases: Vec<(Value, &str)> = vec![
        (request(TENANT, APP, owner, &["tools:*"], 300), "scopes"),
        (request(TENANT, APP, owner, &["list_notes"], 300), "scopes"),
        (request(TENANT, APP, owner, &["tools:List"], 300), "scopes"),
        (request(TENANT, APP, owner, &[], 300), "scopes"),
        (
            request(TENANT, APP, owner, &["tools:a", "tools:a"], 300),
            "scopes",
        ),
        (
            request(TENANT, APP, owner, &["tools:list_notes"], 301),
            "ttl_seconds",
        ),
        (
            request(TENANT, APP, owner, &["tools:list_notes"], 3600),
            "ttl_seconds",
        ),
        (
            request(TENANT, APP, owner, &["tools:list_notes"], 29),
            "ttl_seconds",
        ),
        (
            request(TENANT, APP, "not-an-email", &["tools:list_notes"], 300),
            "email",
        ),
        (
            request(OTHER_TENANT, APP, owner, &["tools:list_notes"], 300),
            "tenant_id",
        ),
        (
            request(TENANT, PLAIN_APP, owner, &["tools:list_notes"], 300),
            "app",
        ),
        (json!({ "type": "agent_token_request" }), "body"),
    ];
    for (body, field) in cases {
        let a = post(n.addr, &path(TENANT, APP), Some(&bearer()), &body).await;
        assert_eq!(a.status, 400, "{body}: {}", a.raw);
        assert_eq!(a.body["error"]["code"], "RENOX_VALIDATION");
        assert_eq!(reason(&a).0, field, "{body}: {}", a.raw);
    }
    let mut extra = request(TENANT, APP, owner, &["tools:list_notes"], 300);
    extra["admin"] = json!(true);
    assert_eq!(
        post(n.addr, &path(TENANT, APP), Some(&bearer()), &extra)
            .await
            .status,
        400
    );
    assert!(mint_scope_ok("tools:list_notes"));
    assert!(!mint_scope_ok("tools:*"));
}

/// 404: an email that is no app user's, or an unverified one
/// (`not_an_app_user`); another tenant's app; an app not on this node; an
/// app without `auth`; another node's id. 401 without the callback token.
#[tokio::test]
async fn not_found_and_unauthenticated() {
    let n = node().await;
    let scopes = ["tools:list_notes"];
    for email in ["nobody@coolair.ae", "pending@coolair.ae"] {
        let a = post(
            n.addr,
            &path(TENANT, APP),
            Some(&bearer()),
            &request(TENANT, APP, email, &scopes, 300),
        )
        .await;
        assert_eq!(a.status, 404, "{}", a.raw);
        assert_eq!(a.body["error"]["code"], "RENOX_NOT_FOUND");
        assert_eq!(reason(&a), ("email", "not_an_app_user"));
    }
    // Another tenant's app on this node, through this tenant's path; an
    // app no entry names here.
    for app in [OTHER_APP, "elsewhere"] {
        let a = post(
            n.addr,
            &path(TENANT, app),
            Some(&bearer()),
            &request(TENANT, app, "owner@coolair.ae", &scopes, 300),
        )
        .await;
        assert_eq!(a.status, 404, "{}", a.raw);
        assert_eq!(reason(&a), ("app", "not_active_on_this_node"));
    }
    // This tenant's app through another tenant's path.
    let a = post(
        n.addr,
        &path(OTHER_TENANT, APP),
        Some(&bearer()),
        &request(OTHER_TENANT, APP, "owner@coolair.ae", &scopes, 300),
    )
    .await;
    assert_eq!(a.status, 404, "{}", a.raw);
    // An app without the auth module.
    let a = post(
        n.addr,
        &path(TENANT, PLAIN_APP),
        Some(&bearer()),
        &request(TENANT, PLAIN_APP, "owner@coolair.ae", &scopes, 300),
    )
    .await;
    assert_eq!(a.status, 404, "{}", a.raw);
    assert_eq!(reason(&a), ("app", "no_auth_module"));
    assert!(!n.plain.is_empty());
    // Another node's id.
    let a = post(
        n.addr,
        &format!("/nodes/node-other/tenants/{TENANT}/apps/{APP}/agent-tokens"),
        Some(&bearer()),
        &request(TENANT, APP, "owner@coolair.ae", &scopes, 300),
    )
    .await;
    assert_eq!(a.status, 404);
    // No callback token, a wrong one, an app's own agent token.
    for auth in [
        None,
        Some("Bearer renox_cb_wrongwrongwrongwrongwrongwrongwr"),
        Some("Bearer renox_agt_x"),
    ] {
        let a = post(
            n.addr,
            &path(TENANT, APP),
            auth,
            &request(TENANT, APP, "owner@coolair.ae", &scopes, 300),
        )
        .await;
        assert_eq!(a.status, 401, "{}", a.raw);
        assert_eq!(a.body["error"]["code"], "RENOX_UNAUTHENTICATED");
    }
}

/// The service runs as the platform only through the node: the app's own
/// route calling `ctx.services.auth.mintAgentToken` is refused.
#[tokio::test]
async fn tenant_code_cannot_mint() {
    let n = node().await;
    let (status, body) = n.app("/mint", None, json!({})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["refused"], true, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Only the platform"),
        "{body}"
    );
}
