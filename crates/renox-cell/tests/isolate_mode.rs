//! Issue #320: `isolate` mode for marketplace modules (`docs/contracts/ops.md`
//! 1.7.0 section 15.6; D12). V8-linked; drives a `CellManager` over a local
//! artifact store like `tests/jobs.rs`.
//!
//! The module `tax` is installed with `isolation = "isolate"`: its code runs
//! in an isolate of its own inside the tenant's process. It cannot reach
//! the app's globals, a secret it did not declare, a table outside its
//! prefix, or a host outside its list; arguments and results cross as JSON
//! of at most 1 MiB; it joins the caller's transaction; its heap limit is
//! its own (B12-style: the bomb ends the module's isolate, the app's keeps
//! answering); and the caller's meter record carries the callee's CPU.
//! `docs/24-threat-model.md` D, "Malicious or compromised marketplace module".

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
use renox_cell::tiers::Tier;
use renox_cell::{CellManager, LocalArtifactStore, ManagerConfig, TierName, Tiers};
use renox_data::{DbOptions, TenantDb, Value};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, MeterRecord, Sink, SinkError};
use renox_runtime::{Runtime, RuntimeConfig};

static N: AtomicU64 = AtomicU64::new(0);
const TENANT: &str = "t_iso";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-iso-{}-{name}-{}",
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

/// The app: a global of its own, then one call into `tax` per query.
const APP: &str = r#"
import { tax } from "renox:modules";
globalThis.__appMarker = "app-only";
let appCounter = 41;
export async function GET(ctx) {
  const q = ctx.url.searchParams;
  const op = q.get("op");
  try {
    if (op === "probe") return Response.json(await tax.probe());
    if (op === "echo") return Response.json({ len: (await tax.echo("x".repeat(Number(q.get("n"))))).length });
    if (op === "big") return Response.json({ len: (await tax.big(Number(q.get("n")))).length });
    if (op === "spin") return Response.json(await tax.spin(Number(q.get("ms"))));
    if (op === "bomb") return Response.json(await tax.bomb());
    if (op === "tx") {
      const fail = q.get("fail") === "1";
      const out = await ctx.db.transaction(async (tx) => {
        await tx.execute("insert into app__orders (id) values (?)", [q.get("id")]);
        const line = await tax.addLine(q.get("id"));
        if (fail) throw new Error("rolled back");
        return line;
      });
      return Response.json({ line: out });
    }
    if (op === "ping") return Response.json({ ok: true, counter: ++appCounter, marker: globalThis.__appMarker });
  } catch (e) {
    return Response.json({ error: e.code ?? e.message, details: e.details ?? null });
  }
  return Response.json({});
}
"#;

/// The `isolate` module: probes what it can reach, echoes, spins, explodes.
const TAX: &str = r#"
const code = async (f) => { try { await f(); return "allowed"; } catch (e) { return e.code ?? e.name; } };
export async function probe(ctx) {
  return {
    marker: typeof globalThis.__appMarker,
    secrets: Object.keys(ctx.secrets).sort(),
    own: ctx.secrets.TAX_KEY === "tax-secret-value-1234",
    otherTable: await code(() => ctx.db.query("select * from app__orders")),
    ownTable: await code(() => ctx.db.query("select * from tax__lines")),
    fetch: await code(() => fetch("https://example.com/")),
    module: ctx.module,
  };
}
export async function echo(ctx, s) { return s; }
export async function big(ctx, n) { return "y".repeat(n); }
export async function spin(ctx, ms) { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x++; return { spun: x > 0 }; }
export async function bomb(ctx) { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }
export async function addLine(ctx, id) {
  await ctx.db.execute("insert into tax__lines (order_id, vat) values (?, ?)", [id, 5]);
  return "line-" + id;
}
"#;

fn artifact(store: &Path) -> String {
    let tmp = scratch("artifact");
    let perms = serde_json::json!({ "tables": "tax__*", "network": [], "secrets": ["TAX_KEY"], "slots": [], "hooks": [] });
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "iso", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/tax/services": "modules/tax/services.js",
        } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" },
        ],
        "permissions": { "network": [], "secrets": ["APP_KEY"] },
        "modules": [{
            "name": "tax", "version": "2.1.0", "hash": "0".repeat(64), "source": "registry:gulfsoft/tax",
            "mount": "/tax", "isolation": "isolate", "dependencies": [], "config": {},
            "permissions": perms, "approved": perms,
            "exports": { "services": ["probe", "echo", "big", "spin", "bomb", "addLine"] },
        }],
    });
    let files: Vec<(&str, String)> = vec![
        (
            "manifest.json",
            serde_json::to_string_pretty(&manifest).unwrap(),
        ),
        ("code/functions/f.js", APP.into()),
        ("code/modules/tax/services.js", TAX.into()),
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

fn open(data: &Path) -> TenantDb {
    let dir = data.join(TENANT);
    std::fs::create_dir_all(&dir).unwrap();
    TenantDb::open(dir.join("app.db"), DbOptions::default()).unwrap()
}

fn prepare(data: &Path) {
    let db = open(data);
    db.execute(
        "create table if not exists app__orders (id text primary key)",
        &[],
    )
    .unwrap();
    db.execute(
        "create table if not exists tax__lines (order_id text, vat integer)",
        &[],
    )
    .unwrap();
    db.close().unwrap();
    let path = data.join(TENANT).join("secrets.json");
    std::fs::write(
        &path,
        r#"{"APP_KEY":"app-secret-value-1234","TAX_KEY":"tax-secret-value-1234"}"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

struct Node {
    manager: CellManager,
    records: Records,
    hash: String,
}

fn node(data: &Path, artifacts: &Path, hash: &str) -> Node {
    let records = Records::default();
    let meter = Meter::start(
        MeterConfig {
            flush_interval: Duration::from_millis(20),
            ..MeterConfig::new("t_iso@test", "test", data)
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
            // B12-style: a small heap and room for the bomb to reach it.
            tiers: Tiers {
                free: Tier {
                    cpu_ms: 5_000,
                    heap_mb: 32,
                    ..Tier::FREE
                },
                ..Tiers::default()
            },
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
    Node {
        manager,
        records,
        hash: hash.to_string(),
    }
}

impl Node {
    async fn get(&self, query: &str) -> (String, serde_json::Value) {
        let request_id = format!("req_{}", N.fetch_add(1, Ordering::SeqCst));
        let ctx = RequestCtx {
            tenant_id: TENANT.into(),
            deployment_hash: self.hash.clone(),
            request_id: request_id.clone(),
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
        (
            request_id,
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
        )
    }

    async fn record(&self, request_id: &str) -> MeterRecord {
        for _ in 0..100 {
            if let Some(r) = self
                .records
                .0
                .lock()
                .unwrap()
                .iter()
                .find(|r| r.request_id == request_id)
            {
                return r.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("no meter record for {request_id}");
    }
}

fn count(data: &Path, sql: &str) -> i64 {
    let db = open(data);
    let n = match db
        .query_one(sql, &[])
        .unwrap()
        .and_then(|r| r.get("n").cloned())
    {
        Some(Value::Integer(n)) => n,
        _ => -1,
    };
    db.close().unwrap();
    n
}

fn setup(name: &str) -> (PathBuf, Node) {
    let root = scratch(name);
    let (data, store) = (root.join("data"), root.join("artifacts"));
    std::fs::create_dir_all(&store).unwrap();
    prepare(&data);
    let hash = artifact(&store);
    let n = node(&data, &store, &hash);
    (data, n)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_isolate_module_reaches_neither_the_apps_globals_nor_undeclared_secrets_tables_or_hosts()
{
    let (_data, n) = setup("probe");
    let (_, p) = n.get("op=probe").await;
    assert_eq!(
        p["marker"], "undefined",
        "the app's globalThis is not reachable: {p}"
    );
    assert_eq!(
        p["secrets"],
        serde_json::json!(["TAX_KEY"]),
        "only its approved secret: {p}"
    );
    assert_eq!(p["own"], true);
    assert_eq!(
        p["otherTable"], "RENOX_DB_AUTH",
        "a table outside tax__*: {p}"
    );
    assert_eq!(p["ownTable"], "allowed");
    assert_eq!(
        p["fetch"], "RENOX_FETCH_BLOCKED",
        "a host outside its list: {p}"
    );
    assert_eq!(p["module"], "tax");
    // The app's own state is untouched and its isolate is a different one.
    let (_, ping) = n.get("op=ping").await;
    assert_eq!(ping["marker"], "app-only");
    assert_eq!(ping["ok"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn arguments_and_results_cross_as_json_of_at_most_one_mebibyte() {
    let (_data, n) = setup("size");
    let (_, ok) = n.get("op=echo&n=1000").await;
    assert_eq!(ok["len"], 1000);
    let (_, args) = n.get("op=echo&n=1100000").await;
    assert_eq!(args["error"], "RENOX_MODULE_SERVICE", "{args}");
    assert_eq!(args["details"]["reason"], "too_large");
    let (_, result) = n.get("op=big&n=1100000").await;
    assert_eq!(result["error"], "RENOX_MODULE_SERVICE", "{result}");
    assert_eq!(result["details"]["reason"], "too_large");
    let (_, under) = n.get("op=big&n=500000").await;
    assert_eq!(under["len"], 500000);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_callee_joins_the_callers_transaction() {
    let (data, n) = setup("tx");
    let (_, ok) = n.get("op=tx&id=o1").await;
    assert_eq!(ok["line"], "line-o1", "{ok}");
    let (_, failed) = n.get("op=tx&id=o2&fail=1").await;
    assert_eq!(failed["error"], "rolled back", "{failed}");
    // o1 committed in both tables, o2 rolled back in both.
    assert_eq!(
        count(
            &data,
            "select count(*) as n from app__orders where id = 'o1'"
        ),
        1
    );
    assert_eq!(
        count(
            &data,
            "select count(*) as n from tax__lines where order_id = 'o1'"
        ),
        1
    );
    assert_eq!(
        count(
            &data,
            "select count(*) as n from app__orders where id = 'o2'"
        ),
        0
    );
    assert_eq!(
        count(
            &data,
            "select count(*) as n from tax__lines where order_id = 'o2'"
        ),
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_modules_heap_limit_is_its_own_and_its_cpu_is_on_the_callers_record() {
    let (_data, n) = setup("heap");
    // B12-style: the bomb ends the module's isolate only.
    let (_, bomb) = n.get("op=bomb").await;
    assert_eq!(bomb["error"], "RENOX_MODULE_SERVICE", "{bomb}");
    assert_eq!(bomb["details"]["cause_code"], "RENOX_OOM", "{bomb}");
    let (_, ping) = n.get("op=ping").await;
    assert_eq!(ping["ok"], true, "the app's isolate kept its state: {ping}");
    assert_eq!(ping["counter"], 42);
    // The module's isolate is created again on the next call.
    let (_, again) = n.get("op=echo&n=10").await;
    assert_eq!(again["len"], 10, "{again}");
    // The callee's CPU is charged to the caller's request.
    let (id, spun) = n.get("op=spin&ms=60").await;
    assert_eq!(spun["spun"], true, "{spun}");
    let rec = n.record(&id).await;
    assert_eq!(rec.route, "GET /");
    assert!(
        rec.cpu_ms >= 40.0,
        "the callee's CPU is on the caller's record: {}",
        rec.cpu_ms
    );
    assert_eq!(n.manager.module_isolates(), 1);
    assert!(
        n.manager
            .metrics_text(None, Vec::new())
            .await
            .contains("renox_module_isolates 1")
    );
}
