//! Issue #229: the cell's outbox delivery worker (`docs/contracts/ops.md`
//! 1.3.0 section 15.4, "Delivery"; ADR D14). V8-linked; drives a
//! `CellManager` directly over a local artifact store.
//!
//! Proves the `docs/23-failure-modes.md` row "Event handler fails
//! repeatedly" (retries with backoff, then a dead letter) and the D14
//! guarantees: delivery only after commit, never after a rollback, and after
//! a worker restart.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http_body_util::BodyExt;
use renox_cell::cell::LocalSecrets;
use renox_cell::manager::StaticTiers;
use renox_cell::outbox::OutboxConfig;
use renox_cell::pages::PlatformKey;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_data::outbox::{self, DeadLetterCap};
use renox_data::{DbOptions, TenantDb, Value};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{
    Meter, MeterBatch, MeterConfig, MeterKind, MeterRecord, MeterStatus, Sink, SinkError,
};
use renox_runtime::{Runtime, RuntimeConfig};

static N: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-outbox-{}-{name}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(Clone, Default)]
struct Records(Arc<Mutex<Vec<MeterRecord>>>);

impl Sink for Records {
    async fn write_batch(&self, batch: &MeterBatch) -> Result<(), SinkError> {
        self.0.lock().unwrap().extend(batch.records.iter().cloned());
        Ok(())
    }
}

fn module(name: &str, exports: serde_json::Value) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": "shared", "dependencies": [], "config": {},
        "permissions": perms, "approved": perms, "exports": exports,
    })
}

const BILLING: &str = r#"
export async function pay(ctx, invoice, fail) {
  return ctx.db.transaction(async () => {
    const id = await ctx.events.emit("billing.invoice_paid", { invoice_id: invoice });
    if (fail) throw new Error("rolled back");
    return id;
  });
}
"#;

fn handler(module: &str) -> String {
    format!(
        r#"
export const on = {{
  "billing.invoice_paid": async (ctx, e) => {{
    if (e.payload.invoice_id === "throw") throw new Error("smtp down");
    if (e.payload.invoice_id === "spin") {{ const t = Date.now(); while (Date.now() - t < 200) {{}} }}
    await ctx.db.execute("insert into {module}__seen (event_id, attempt) values (?, ?)", [e.id, e.attempt]);
  }},
}};
"#
    )
}

const APP: &str = r#"
import { billing } from "renox:modules";
export async function GET(ctx) {
  const invoice = ctx.url.searchParams.get("invoice");
  const fail = ctx.url.searchParams.get("fail") === "1";
  try { return Response.json({ id: await billing.pay(invoice, fail) }); }
  catch (e) { return Response.json({ error: e.code ?? e.message }); }
}
"#;

/// An artifact directory named by its canonical hash.
fn artifact(store: &Path) -> String {
    let tmp = scratch("artifact");
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "outbox", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/billing/services": "modules/billing/services.js",
            "modules/email/hooks": "modules/email/hooks.js",
            "modules/audit/hooks": "modules/audit/hooks.js",
        } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": [
            module("billing", serde_json::json!({ "services": ["pay"], "events": { "billing.invoice_paid": { "type": "object" } } })),
            module("email", serde_json::json!({})),
            module("audit", serde_json::json!({})),
        ],
    });
    let files: Vec<(&str, String)> = vec![
        (
            "manifest.json",
            serde_json::to_string_pretty(&manifest).unwrap(),
        ),
        ("code/functions/f.js", APP.into()),
        ("code/modules/billing/services.js", BILLING.into()),
        ("code/modules/email/hooks.js", handler("email")),
        ("code/modules/audit/hooks.js", handler("audit")),
    ];
    for (p, src) in &files {
        let path = tmp.join(p);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, src).unwrap();
    }
    let hash = renox_cell::artifact::canonical_hash(&tmp).unwrap();
    std::fs::rename(&tmp, store.join(&hash)).unwrap();
    hash
}

const TENANT: &str = "t_outbox";

/// The module tables exist before the cell opens the file (module
/// migrations are #235's).
fn prepare_db(data: &Path) {
    let dir = data.join(TENANT);
    std::fs::create_dir_all(&dir).unwrap();
    let db = TenantDb::open(dir.join("app.db"), DbOptions::default()).unwrap();
    for m in ["email", "audit"] {
        db.execute(
            &format!("create table if not exists {m}__seen (event_id text, attempt integer)"),
            &[],
        )
        .unwrap();
    }
    db.close().unwrap();
}

struct Node {
    manager: CellManager,
    records: Records,
    hash: String,
}

fn fast() -> OutboxConfig {
    OutboxConfig {
        base: Duration::from_millis(20),
        cap: Duration::from_millis(200),
        jitter: 0.2,
        ..OutboxConfig::default()
    }
}

fn node(data: &Path, artifacts: &Path, hash: &str, outbox: OutboxConfig) -> Node {
    let records = Records::default();
    let meter = Meter::start(
        MeterConfig {
            flush_interval: Duration::from_millis(20),
            ..MeterConfig::new("t_outbox@test", "test", data)
        },
        records.clone(),
    );
    let manager = CellManager::new(
        Runtime::new(RuntimeConfig::default()),
        meter,
        ManagerConfig {
            data_dir: data.to_path_buf(),
            artifacts: Arc::new(LocalArtifactStore::new(artifacts)),
            idle_timeout: Duration::from_secs(600),
            tiers: Tiers::default(),
            deployments: Arc::new(StaticTiers {
                default_tier: TierName::Free,
                tenant_tiers: BTreeMap::new(),
            }),
            secrets: Arc::new(LocalSecrets {
                data_dir: data.to_path_buf(),
            }),
            platform_key: PlatformKey::random(),
        },
    );
    manager.set_outbox_config(outbox);
    Node {
        manager,
        records,
        hash: hash.to_string(),
    }
}

impl Node {
    async fn get(&self, query: &str) -> serde_json::Value {
        let ctx = RequestCtx {
            tenant_id: TENANT.into(),
            deployment_hash: self.hash.clone(),
            request_id: format!("req_{}", N.fetch_add(1, Ordering::SeqCst)),
            deadline: Instant::now() + Duration::from_secs(30),
            client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
            csp_nonce: "n".into(),
        };
        let req = http::Request::builder()
            .uri(format!("https://t.renox.app/?{query}"))
            .header("host", "t.renox.app")
            .body(axum::body::Body::empty())
            .unwrap();
        let res = self.manager.dispatch(ctx, req).await;
        let body = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null)
    }

    fn event_records(&self) -> Vec<MeterRecord> {
        self.records
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.kind == Some(MeterKind::Event))
            .cloned()
            .collect()
    }
}

/// Rows of `<module>__seen`, read with a fresh connection.
fn seen(data: &Path, module: &str) -> Vec<(String, i64)> {
    let db = TenantDb::open(data.join(TENANT).join("app.db"), DbOptions::default()).unwrap();
    db.query(
        &format!("select event_id, attempt from {module}__seen order by rowid"),
        &[],
    )
    .unwrap()
    .into_iter()
    .map(|r| {
        let id = match r.get("event_id") {
            Some(Value::Text(t)) => t.clone(),
            _ => String::new(),
        };
        let n = match r.get("attempt") {
            Some(Value::Integer(i)) => *i,
            _ => 0,
        };
        (id, n)
    })
    .collect()
}

async fn eventually(within: Duration, mut f: impl FnMut() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < within {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    f()
}

fn setup() -> (PathBuf, PathBuf, String) {
    let data = scratch("data");
    let artifacts = scratch("artifacts");
    let hash = artifact(&artifacts);
    prepare_db(&data);
    (data, artifacts, hash)
}

/// After the commit, every module with a handler gets the event once (the
/// fan-out); the ack leaves no row; each attempt is a `kind: "event"` record.
#[tokio::test]
async fn delivered_after_commit_to_both_modules() {
    let (data, artifacts, hash) = setup();
    let n = node(&data, &artifacts, &hash, fast());
    let v = n.get("invoice=i1").await;
    let id = v["id"].as_str().expect("an id").to_string();
    assert!(
        eventually(Duration::from_secs(10), || seen(&data, "email").len() == 1
            && seen(&data, "audit").len() == 1)
        .await,
        "{:?} {:?}",
        seen(&data, "email"),
        seen(&data, "audit")
    );
    assert_eq!(seen(&data, "email"), vec![(id.clone(), 1)]);
    assert_eq!(seen(&data, "audit"), vec![(id.clone(), 1)]);
    let stats = n.manager.outbox_stats(TENANT).await.unwrap();
    assert_eq!((stats.pending, stats.dead), (0, 0));
    assert!(eventually(Duration::from_secs(5), || n.event_records().len() == 2).await);
    let mut routes: Vec<String> = n.event_records().iter().map(|r| r.route.clone()).collect();
    routes.sort();
    assert_eq!(
        routes,
        [
            "EVENT audit billing.invoice_paid",
            "EVENT email billing.invoice_paid"
        ]
    );
    assert!(
        n.event_records()
            .iter()
            .all(|r| r.status == MeterStatus::Ok && r.http_status == 200)
    );
    assert!(
        n.event_records()
            .iter()
            .any(|r| r.request_id == format!("{id}_email_1"))
    );
}

/// D14: the emit rolled back with its transaction; nothing is delivered.
#[tokio::test]
async fn not_delivered_after_rollback() {
    let (data, artifacts, hash) = setup();
    let n = node(&data, &artifacts, &hash, fast());
    let v = n.get("invoice=i2&fail=1").await;
    assert!(v["error"].is_string(), "{v}");
    // A committed event afterwards proves the worker is running.
    n.get("invoice=i3").await;
    assert!(eventually(Duration::from_secs(10), || seen(&data, "email").len() == 1).await);
    assert_eq!(seen(&data, "email").len(), 1);
    assert_eq!(n.manager.outbox_stats(TENANT).await.unwrap().pending, 0);
}

/// docs/23-failure-modes.md "Event handler fails repeatedly": 8 attempts
/// with growing delays, then a dead letter with the last error; the other
/// module's delivery is not re-run.
#[tokio::test]
async fn a_handler_throwing_eight_times_lands_in_dead_letter() {
    let (data, artifacts, hash) = setup();
    let n = node(&data, &artifacts, &hash, fast());
    n.get("invoice=throw").await;
    let dead = || {
        let db = TenantDb::open(data.join(TENANT).join("app.db"), DbOptions::default()).unwrap();
        outbox::dead_letters(&db, 10).unwrap()
    };
    assert!(
        eventually(Duration::from_secs(30), || dead().len() == 2).await,
        "{:?}",
        dead()
    );
    let d = dead();
    assert!(
        d.iter()
            .all(|r| r.attempts == 8 && r.last_error.as_deref() == Some("threw"))
    );
    assert!(
        d.iter()
            .all(|r| !r.last_error.as_deref().unwrap_or("").contains("smtp"))
    );
    // Backoff: the attempts of one delivery start further and further apart.
    assert!(eventually(Duration::from_secs(5), || n.event_records().len() >= 16).await);
    let mut starts: Vec<u64> = n
        .event_records()
        .iter()
        .filter(|r| r.route == "EVENT email billing.invoice_paid")
        .map(|r| r.started_at)
        .collect();
    starts.sort();
    assert_eq!(starts.len(), 8);
    let gaps: Vec<u64> = starts.windows(2).map(|w| w[1] - w[0]).collect();
    // 20 ms doubling, capped at 200 ms, ± 20 %: the late gaps are longer.
    assert!(gaps[0] >= 15, "{gaps:?}");
    assert!(gaps[5] >= 150, "{gaps:?}");
    assert!(
        n.event_records()
            .iter()
            .all(|r| r.status == MeterStatus::Error && r.http_status == 500)
    );
    assert_eq!(n.manager.outbox_stats(TENANT).await.unwrap().dead, 2);
}

/// Pending rows written while no cell was running are delivered by the next
/// one: a new manager over the same file scans what is due when its cell is
/// created.
#[tokio::test]
async fn a_restarted_worker_delivers_the_pending_row() {
    let (data, artifacts, hash) = setup();
    {
        let db = TenantDb::open(data.join(TENANT).join("app.db"), DbOptions::default()).unwrap();
        outbox::emit_autocommit(
            &db,
            &outbox::OutboxEvent {
                id: "01JBQ3Z7MA0000000000000009".into(),
                name: "billing.invoice_paid".into(),
                payload: r#"{"invoice_id":"before_restart"}"#.into(),
                module: "billing".into(),
                created_at: 1,
            },
        )
        .unwrap();
        db.close().unwrap();
    }
    let n = node(&data, &artifacts, &hash, fast());
    // Any request creates the cell; its worker scans on start.
    n.get("invoice=after").await;
    assert!(
        eventually(Duration::from_secs(10), || seen(&data, "email")
            .iter()
            .any(|(id, _)| id == "01JBQ3Z7MA0000000000000009"))
        .await
    );
}

/// A handler over the tier's CPU limit is a failed attempt, metered as
/// `cpu_limit` with `kind: "event"`.
#[tokio::test]
async fn a_handler_over_the_cpu_limit_is_a_failed_attempt() {
    let (data, artifacts, hash) = setup();
    let n = node(
        &data,
        &artifacts,
        &hash,
        OutboxConfig {
            max_attempts: 1,
            dead: DeadLetterCap::default(),
            ..fast()
        },
    );
    n.get("invoice=spin").await;
    assert!(eventually(Duration::from_secs(20), || n.event_records().len() >= 2).await);
    let r = n.event_records();
    assert!(
        r.iter()
            .all(|r| r.status == MeterStatus::CpuLimit && r.kind == Some(MeterKind::Event)),
        "{r:?}"
    );
    assert!(seen(&data, "email").is_empty());
    assert_eq!(n.manager.outbox_stats(TENANT).await.unwrap().dead, 2);
}

/// D14, no polling: an idle tenant's file sees no statement for 5 s.
#[tokio::test]
async fn an_idle_tenant_is_not_polled() {
    let (data, artifacts, hash) = setup();
    let n = node(&data, &artifacts, &hash, fast());
    n.get("invoice=i9").await;
    assert!(eventually(Duration::from_secs(10), || seen(&data, "audit").len() == 1).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let before = n.manager.db_stats(TENANT).await.unwrap();
    tokio::time::sleep(Duration::from_secs(5)).await;
    let after = n.manager.db_stats(TENANT).await.unwrap();
    assert_eq!(
        after.statements, before.statements,
        "the worker read an idle tenant"
    );
}
