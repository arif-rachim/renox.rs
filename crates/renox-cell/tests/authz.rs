//! Issue #279 end to end in the cell (V8-linked): the engine built from the
//! artifact's policies at cell creation, the principal from the `auth`
//! module's `principal` service, the route `guard` before the loader (and
//! on a fragment request), the principal cache dropped by
//! `authz.roles_changed` through the cell's own outbox, and the anonymous
//! principal of an app without `auth` (`docs/contracts/ops.md` 1.5.0
//! section 17).
//!
//! Proves `docs/23-failure-modes.md` F5 "Policy denies" (the loader's side
//! effect is absent after a denied guard) and the `docs/24-threat-model.md`
//! row "guard on every route" (fragment requests included).

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use renox_cell::cell::LocalSecrets;
use renox_cell::manager::StaticTiers;
use renox_cell::pages::PlatformKey;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterConfig, StdoutSink};
use renox_runtime::{Runtime, RuntimeConfig};
use renox_template::{CompileOptions, Compiler, TemplateProject};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-authz-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const AUTH: &str = r#"
export async function principal(ctx) {
  const m = /(?:^|;\s*)uid=([a-z_0-9]+)/.exec(ctx.headers.get("cookie") ?? "");
  return m ? { id: m[1], attrs: { org: "o_1" } } : null;
}
"#;

const ORDER_JS: &str = r#"
export async function load(ctx) {
  await ctx.db.execute("insert into app__seen (id) values (?)", [ctx.params.id]);
  return { title: "Order " + ctx.params.id };
}
"#;

const API_JS: &str = r#"
export async function GET(ctx) {
  return Response.json({ principal: ctx.principal });
}
export async function POST(ctx) {
  await ctx.authz.roles.assign(ctx.url.searchParams.get("user"), "auditor");
  return Response.json({ ok: true });
}
"#;

const BOARD_JS: &str = r#"
export async function load(ctx) {
  return { orders: [
    { type: "Order", id: "o1", owner: "u_alice" },
    { type: "Order", id: "o2", owner: "u_bob" },
    { type: "Order", id: "o3" },
  ] };
}
"#;

const REPORTS_JS: &str = r#"
export async function GET(ctx) { return Response.json({ report: "q3" }); }
"#;

const POLICIES: &str = r#"
permit (principal is Renox::User, action == Renox::Action::"order.read", resource is App::Order)
when { resource.owner == principal.id };
permit (principal in Renox::Role::"auditor", action == Renox::Action::"report.read", resource);
"#;

fn sha(s: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn module(name: &str, services: &[&str]) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": "shared", "dependencies": [], "config": {},
        "permissions": perms, "approved": perms, "exports": { "services": services },
    })
}

/// The artifact; `with_auth` installs the fixture `auth` module.
fn artifact(store: &Path, with_auth: bool) -> String {
    artifact_with(store, with_auth, "report.read")
}

/// `menu_action` is the action `pages/menu` names in its `r-can`.
fn artifact_with(store: &Path, with_auth: bool, menu_action: &str) -> String {
    let mut project = TemplateProject::new();
    project.insert(
        "pages/orders/[id].html",
        r#"<h1 id="title">{{ title }}</h1>"#,
    );
    // #280: `r-can` both ways, against the deployment's policies.
    project.insert(
        "pages/board.html",
        r#"<p r-can="report.read">reports</p><p r-cannot="report.read">no reports</p><ul><li r-for="o in orders"><a r-can="order.read" :resource="o">open {{ o.id }}</a></li></ul>"#,
    );
    project.insert(
        "pages/menu.html",
        format!(r#"<nav><a r-can="{menu_action}" href="/reports">Reports</a><i>menu</i></nav>"#),
    );
    let compiled = Compiler::new(CompileOptions::default())
        .compile(&project)
        .unwrap_or_else(|d| panic!("{d:?}"));
    let tmp = scratch("artifact");
    for (rel, src) in compiled.files() {
        let p = tmp.join("templates").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let mut code = vec![
        ("pages/orders/[id].js", ORDER_JS),
        ("functions/api.js", API_JS),
        ("functions/reports.js", REPORTS_JS),
        ("pages/board.js", BOARD_JS),
    ];
    if with_auth {
        code.push(("modules/auth/services.js", AUTH));
    }
    for (rel, src) in &code {
        let p = tmp.join("code").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let sql = "create table app__orders (id text primary key, owner text);\n\
        insert into app__orders values ('o1', 'u_alice'), ('o2', 'u_bob');\n\
        create table app__seen (id text);\n";
    std::fs::create_dir_all(tmp.join("migrations/app")).unwrap();
    std::fs::write(tmp.join("migrations/app/001_init.sql"), sql).unwrap();
    std::fs::write(
        tmp.join("migrations/checksums.json"),
        serde_json::json!({ "version": 0, "files": { "app/001_init.sql": sha(sql) } }).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(tmp.join("policies/app")).unwrap();
    std::fs::write(tmp.join("policies/app/default.cedar"), POLICIES).unwrap();
    let mut entry: BTreeMap<&str, &str> = BTreeMap::from([
        ("pages/orders/[id]", "pages/orders/[id].js"),
        ("functions/api", "functions/api.js"),
        ("functions/reports", "functions/reports.js"),
        ("pages/board", "pages/board.js"),
    ]);
    if with_auth {
        entry.insert("modules/auth/services", "modules/auth/services.js");
    }
    let mut manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "shop", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": entry },
        "routes": [
            { "kind": "page", "path": "/orders/:id", "module": "pages/orders/[id]", "load": true, "template": "pages/orders/[id]",
              "guard": { "action": "order.read", "resource": { "type": "Order", "id": ":id" } } },
            { "kind": "function", "method": "GET", "path": "/api", "module": "functions/api", "export": "GET" },
            { "kind": "function", "method": "POST", "path": "/api", "module": "functions/api", "export": "POST" },
            { "kind": "function", "method": "GET", "path": "/reports", "module": "functions/reports", "export": "GET",
              "guard": { "action": "report.read" } },
            { "kind": "page", "path": "/board", "module": "pages/board", "load": true, "template": "pages/board" },
            { "kind": "page", "path": "/menu", "template": "pages/menu" },
        ],
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] },
        "authz": {
            "actions": ["order.read", "report.read"],
            "entities": { "Order": { "table": "app__orders", "attrs": ["owner"] } },
            "default_roles": { "auditor": ["report.read"] },
        },
    });
    if with_auth {
        manifest["modules"] = serde_json::json!([module("auth", &["principal"])]);
    }
    std::fs::write(
        tmp.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let hash = renox_cell::artifact::canonical_hash(&tmp).unwrap();
    std::fs::rename(&tmp, store.join(&hash)).unwrap();
    hash
}

struct Node {
    manager: CellManager,
    hash: String,
    data: PathBuf,
}

fn node(with_auth: bool) -> Node {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let data = scratch("data");
    let artifacts = scratch("artifacts");
    let hash = artifact(&artifacts, with_auth);
    let meter = Meter::start(MeterConfig::new("t_authz@test", "test", &data), StdoutSink);
    let manager = CellManager::new(
        Runtime::new(RuntimeConfig::default()),
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
        data,
    }
}

impl Node {
    async fn send(&self, method: &str, path: &str, headers: &[(&str, &str)]) -> (u16, String) {
        let ctx = RequestCtx {
            tenant_id: "t_authz".into(),
            deployment_hash: self.hash.clone(),
            request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let mut b = http::Request::builder()
            .method(method)
            .uri(format!("https://t.renox.app{path}"))
            .header("host", "t.renox.app")
            .header("accept", "text/html");
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let res = self
            .manager
            .dispatch(ctx, b.body(axum::body::Body::empty()).unwrap())
            .await;
        let status = res.status().as_u16();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn seen(&self) -> usize {
        let db = renox_data::TenantDb::open(
            self.data.join("t_authz").join("app.db"),
            renox_data::DbOptions::default(),
        );
        match db {
            Ok(db) => db
                .query("select id from app__seen", &[])
                .map(|r| r.len())
                .unwrap_or(0),
            Err(_) => 0,
        }
    }
}

/// The guard is evaluated before the loader: a denied page answers 403
/// with the error page and the loader's write never happens; a fragment
/// request is guarded the same way.
#[tokio::test]
async fn guard_denies_before_the_loader_and_on_fragments() {
    let n = node(true);
    let alice = [("cookie", "uid=u_alice")];
    let (status, html) = n.send("GET", "/orders/o1", &alice).await;
    assert_eq!(status, 200, "{html}");
    assert!(html.contains(">Order o1</h1>"), "{html}");
    let (status, html) = n.send("GET", "/orders/o2", &alice).await;
    assert_eq!(status, 403, "{html}");
    assert!(
        html.contains("RENOX_FORBIDDEN") || html.contains("not allowed"),
        "{html}"
    );
    let (status, _) = n
        .send(
            "GET",
            "/orders/o2",
            &[
                ("cookie", "uid=u_alice"),
                ("hx-request", "true"),
                ("hx-target", "title"),
            ],
        )
        .await;
    assert_eq!(status, 403, "fragment requests are guarded too");
    let (status, _) = n.send("GET", "/orders/o1", &[]).await;
    assert_eq!(status, 403, "anonymous");
    assert_eq!(n.seen(), 1, "only the allowed request ran the loader");
}

/// A role change is visible within one outbox round trip: the
/// `authz.roles_changed` event drops the cached principal.
#[tokio::test]
async fn a_role_change_invalidates_the_cached_principal() {
    let n = node(true);
    let alice = [("cookie", "uid=u_alice")];
    let (status, _) = n.send("GET", "/reports", &alice).await;
    assert_eq!(status, 403);
    let (status, body) = n.send("GET", "/api", &alice).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains(r#""roles":[]"#), "{body}");
    let (status, body) = n.send("POST", "/api?user=u_alice", &[]).await;
    assert_eq!(status, 200, "{body}");
    let t0 = Instant::now();
    loop {
        let (status, _) = n.send("GET", "/reports", &alice).await;
        if status == 200 {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "the cached principal was not dropped"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    eprintln!("role change visible after {:?}", t0.elapsed());
    let (_, body) = n.send("GET", "/api", &alice).await;
    assert!(body.contains(r#""role":"auditor""#), "{body}");
    // The operator counters: the cache answered at least once, and the
    // guards were counted as decisions.
    let stats = n.manager.authz_stats();
    assert!(stats.cache_hits > 0 && stats.cache_misses > 0, "{stats:?}");
    assert!(stats.decisions >= 2, "{stats:?}");
    assert!(
        stats.hit_rate() > 0.0 && stats.hit_rate() < 1.0,
        "{stats:?}"
    );
}

/// An app without `auth` installed: every request is anonymous.
#[tokio::test]
async fn an_app_without_auth_is_anonymous() {
    let n = node(false);
    let (status, body) = n.send("GET", "/api", &[("cookie", "uid=u_alice")]).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body, r#"{"principal":null}"#);
    let (status, _) = n
        .send("GET", "/orders/o1", &[("cookie", "uid=u_alice")])
        .await;
    assert_eq!(status, 403);
}

/// #280: `r-can` without a resource reads the principal's action set, with
/// a resource one evaluation per row (`o3` lacks the declared `owner`
/// attribute: denied); a page without `load` still gets the principal; a
/// role change shows on the next render. The meter counts the row checks.
#[tokio::test]
async fn r_can_in_templates_reads_the_policies() {
    let n = node(true);
    let alice = [("cookie", "uid=u_alice")];
    let (status, html) = n.send("GET", "/board", &alice).await;
    assert_eq!(status, 200, "{html}");
    assert!(html.contains("open o1"), "{html}");
    assert!(!html.contains("open o2"), "another owner's row: {html}");
    assert!(
        !html.contains("open o3"),
        "missing attribute denies: {html}"
    );
    assert!(
        html.contains("<p>no reports</p>") && !html.contains("<p>reports</p>"),
        "{html}"
    );
    let (status, html) = n.send("GET", "/menu", &alice).await;
    assert_eq!(status, 200, "{html}");
    assert!(!html.contains("/reports"), "{html}");
    let (status, _) = n.send("POST", "/api?user=u_alice", &[]).await;
    assert_eq!(status, 200);
    let t0 = Instant::now();
    loop {
        let (_, html) = n.send("GET", "/menu", &alice).await;
        if html.contains(r#"href="/reports""#) {
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "the new role never reached r-can: {html}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (_, html) = n.send("GET", "/board", &alice).await;
    assert!(html.contains("<p>reports</p>"), "{html}");
}

/// #280 at prepare: a template naming an action no owner declares refuses
/// the deployment (V25, `RENOX_POLICY_INVALID`).
#[tokio::test]
async fn an_undeclared_template_action_refuses_the_deployment() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let data = scratch("data");
    let artifacts = scratch("artifacts");
    // The same artifact as `node`, but `pages/menu` names `report.delete`.
    let hash = artifact_with(&artifacts, true, "report.delete");
    let meter = Meter::start(MeterConfig::new("t_authz@test", "test", &data), StdoutSink);
    let manager = CellManager::new(
        Runtime::new(RuntimeConfig::default()),
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
    let n = Node {
        manager,
        hash,
        data,
    };
    let (status, body) = n.send("GET", "/menu", &[]).await;
    assert_eq!(status, 500, "{body}");
}
