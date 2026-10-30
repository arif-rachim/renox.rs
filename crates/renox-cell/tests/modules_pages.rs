//! Issue #232: module pages, partials, overrides, and slots in the cell
//! (`docs/contracts/artifact.md` 1.1, "Modules"). V8-linked; drives a
//! `CellManager` directly over a local artifact store, with the templates
//! compiled by `renox-template` as `renox build` does.

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
use renox_template::{CompileOptions, Compiler, SlotFiller, TemplateProject};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-modpages-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const LAYOUT: &str = r#"<!doctype html>
<html lang="en"><head><title>Shop</title></head>
<body><header><a href="/">Shop</a><r-slot name="app.header" /></header><main><slot /></main></body></html>"#;

const LOGIN_HTML: &str = r#"<r-layout use="main"><h1 id="title">{{ title }}</h1><p id="who">{{ mod }} {{ path }}</p><auth:login-form /></r-layout>"#;
const LOGIN_JS: &str = r#"
export async function load(ctx) {
  const users = (await ctx.db.query("select count(*) as n from auth__users"))[0].n;
  return { title: "Sign in " + users, path: ctx.url.pathname, mod: ctx.module, actions: ctx.url.searchParams.has("billing") ? ["billing.view"] : [] };
}
"#;
/// The tenant's override of `auth`'s `login-form`. It names `users`, which
/// the module's loader computes but does not return (#275 item 4).
const OVERRIDE: &str = r#"<form class="shop-login"><input name="email" placeholder="you@shop"></form><p id="leak">[{{ users }}]</p>"#;
const INDEX_HTML: &str = r#"<r-layout use="main"><h1>Home</h1></r-layout>"#;

fn module(name: &str, mount: &str, slots: &[&str]) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": slots, "hooks": [] });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": mount, "isolation": "shared", "dependencies": [], "config": {},
        "permissions": perms, "approved": perms, "exports": {},
    })
}

/// The artifact as `renox build` lays it out (artifact.md 1.1): module
/// templates under `modules/<name>/`, the tenant's override of `auth`'s
/// `login-form` partial compiled into its id, and the slot registry.
fn artifact(store: &Path) -> String {
    let mut project = TemplateProject::new();
    project.insert("pages/_layouts/main.html", LAYOUT);
    project.insert("pages/index.html", INDEX_HTML);
    project.insert("modules/auth/pages/login.html", LOGIN_HTML);
    project.insert(
        "modules/auth/partials/login-form.html",
        r#"<form class="auth-original"><input name="email"></form>"#,
    );
    project.insert("overrides/auth/partials/login-form.html", OVERRIDE);
    project.insert(
        "modules/auth/partials/account-menu.html",
        r#"<a class="account-menu" href="/auth/login">Account</a>"#,
    );
    project.insert(
        "modules/billing/partials/plan.html",
        r#"<span class="plan-badge">Pro</span>"#,
    );
    let slots = BTreeMap::from([(
        "app.header".to_string(),
        vec![
            SlotFiller::from("modules/auth/partials/account-menu"),
            SlotFiller {
                template: "modules/billing/partials/plan".into(),
                requires: Some("billing.view".into()),
            },
        ],
    )]);
    let compiled = Compiler::new(CompileOptions {
        slots: slots.clone(),
        ..CompileOptions::default()
    })
    .compile(&project)
    .unwrap_or_else(|d| panic!("{d:?}"));
    let tmp = scratch("artifact");
    for (rel, src) in compiled.files() {
        let p = tmp.join("templates").join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, src).unwrap();
    }
    let code = tmp.join("code/modules/auth/pages/login.js");
    std::fs::create_dir_all(code.parent().unwrap()).unwrap();
    std::fs::write(code, LOGIN_JS).unwrap();
    let over = tmp.join("overrides/auth/partials/login-form.html");
    std::fs::create_dir_all(over.parent().unwrap()).unwrap();
    std::fs::write(&over, OVERRIDE).unwrap();
    std::fs::write(
        tmp.join("overrides.json"),
        serde_json::json!({ "version": 0, "files": { "auth/partials/login-form.html": {
            "template": "modules/auth/partials/login-form", "original_sha256": "0".repeat(64) } } })
        .to_string(),
    )
    .unwrap();
    // Module migrations run in `modules` order, the app's last (artifact.md 1.1).
    let sha = |s: &str| {
        use sha2::Digest;
        sha2::Sha256::digest(s.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let auth_sql = "create table auth__users (id integer primary key, email text);\n\
        insert into auth__users (email) values ('a@x'), ('b@x');\n\
        create view auth__public_users_v1 as select id from auth__users;\n";
    let app_sql = "create table app__seen (n integer);\n\
        insert into app__seen select count(*) from auth__public_users_v1;\n";
    for (path, sql) in [
        ("auth/001_users.sql", auth_sql),
        ("app/001_init.sql", app_sql),
    ] {
        let p = tmp.join("migrations").join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, sql).unwrap();
    }
    std::fs::write(
        tmp.join("migrations/checksums.json"),
        serde_json::json!({ "version": 0, "files": {
            "auth/001_users.sql": sha(auth_sql), "app/001_init.sql": sha(app_sql) } })
        .to_string(),
    )
    .unwrap();
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "shop", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": { "modules/auth/pages/login": "modules/auth/pages/login.js" } },
        "routes": [
            { "kind": "page", "path": "/", "template": "pages/index" },
            { "kind": "page", "path": "/auth/login", "module": "modules/auth/pages/login", "load": true, "template": "modules/auth/pages/login" },
        ],
        "templates": compiled.manifest_entries(),
        "permissions": { "network": [], "secrets": [] },
        "modules": [module("auth", "/auth", &["app.header"]), module("billing", "/billing", &["app.header"])],
        "slots": { "app.header": [
            { "module": "auth", "template": "modules/auth/partials/account-menu" },
            { "module": "billing", "template": "modules/billing/partials/plan", "requires": "billing.view" },
        ] },
    });
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
}

fn node() -> Node {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let data = scratch("data");
    let artifacts = scratch("artifacts");
    let hash = artifact(&artifacts);
    let meter = Meter::start(MeterConfig::new("t_pages@test", "test", &data), StdoutSink);
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
            secrets: Arc::new(LocalSecrets { data_dir: data }),
            platform_key: PlatformKey::random(),
        },
    );
    Node { manager, hash }
}

impl Node {
    async fn get(&self, path: &str) -> (u16, String) {
        let ctx = RequestCtx {
            tenant_id: "t_pages".into(),
            deployment_hash: self.hash.clone(),
            request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let req = http::Request::builder()
            .uri(format!("https://t.renox.app{path}"))
            .header("host", "t.renox.app")
            .header("accept", "text/html")
            .body(axum::body::Body::empty())
            .unwrap();
        let res = self.manager.dispatch(ctx, req).await;
        let status = res.status().as_u16();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&body).into_owned())
    }
}

/// A module page under its mount renders with its own partial; the loader
/// runs in the module's ctx and sees the full path.
#[tokio::test]
async fn a_module_page_renders_under_its_mount_with_its_partials() {
    let n = node();
    let (status, html) = n.get("/auth/login").await;
    assert_eq!(status, 200, "{html}");
    assert!(
        html.contains(">Sign in 2</h1>"),
        "auth's migration ran: {html}"
    );
    assert!(
        html.contains(">auth /auth/login</p>"),
        "loader in the auth ctx: {html}"
    );
    let (status, _) = n.get("/login").await;
    assert_eq!(status, 404, "the module's page is only under its mount");
}

/// The tenant's override replaces the module's partial.
#[tokio::test]
async fn an_override_replaces_the_module_partial() {
    let n = node();
    let (_, html) = n.get("/auth/login").await;
    assert!(html.contains(r#"class="shop-login""#), "{html}");
    assert!(!html.contains("auth-original"), "{html}");
}

/// An override cannot read loader data the module did not disclose
/// (`docs/24-threat-model.md` D, "Template override reads module data";
/// #275 item 4): `users` is a local of `auth`'s loader, not part of its
/// result, so the override's `{{ users }}` compiles and renders empty
/// (`renox-template` leaves an undefined name empty), while the values the
/// loader returned still render.
#[tokio::test]
async fn an_override_cannot_read_data_the_loader_did_not_return() {
    let n = node();
    let (status, html) = n.get("/auth/login").await;
    assert_eq!(status, 200, "{html}");
    assert!(html.contains(r#"<p id="leak" dir="auto">[]</p>"#), "{html}");
    assert!(html.contains(">Sign in 2</h1>"), "{html}");
}

/// The slot's fillers render in provider order; the filler with `requires`
/// is skipped without the action (F5's policy set is empty) and rendered
/// when the page's data carries it.
#[tokio::test]
async fn slot_fillers_render_in_order_and_requires_skips() {
    let n = node();
    let (status, html) = n.get("/").await;
    assert_eq!(status, 200, "{html}");
    assert!(html.contains("account-menu"), "{html}");
    assert!(
        !html.contains("plan-badge"),
        "requires billing.view: {html}"
    );
    let (_, html) = n.get("/auth/login?billing=1").await;
    let a = html.find("account-menu").expect("first filler");
    let b = html
        .find("plan-badge")
        .expect("second filler with its action");
    assert!(a < b, "provider order: {html}");
}
