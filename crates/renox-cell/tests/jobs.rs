//! Issue #297: scheduled and queued jobs (`docs/contracts/ops.md` 1.6.0
//! section 20). V8-linked; drives a `CellManager` over a local artifact
//! store like `tests/outbox.rs`.
//!
//! Proves the `docs/23-failure-modes.md` row "Job overlaps or is missed":
//! missed ticks coalesce into one run after downtime, a second tick during
//! a run waits for it, a row left running is queued again at start; and
//! the jobs half of "Event handler fails repeatedly" (a failing job is
//! dead-lettered, listed without its payload, retried with an audit row).

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
use renox_data::{DbOptions, TenantDb, Value};
use renox_gateway::{CellDispatcher, RequestCtx};
use renox_meter::{Meter, MeterBatch, MeterConfig, MeterKind, MeterRecord, Sink, SinkError};
use renox_runtime::ops::jobs;
use renox_runtime::{Runtime, RuntimeConfig};

static N: AtomicU64 = AtomicU64::new(0);
const TENANT: &str = "t_jobs";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "renox-cell-jobs-{}-{name}-{}",
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

/// The app's job: every minute; a queued run's payload can make it spin or throw.
const REPORT: &str = r#"
export const schedule = "* * * * *";
export async function run(ctx) {
  const started = Date.now();
  const p = ctx.job.payload;
  if (p && p.throw) throw new Error("smtp down");
  if (p && p.spin) await new Promise((r) => setTimeout(r, p.spin));
  await ctx.db.execute(
    "insert into app__runs (id, tick, attempt, payload, principal, kind, started, ended) values (?, ?, ?, ?, ?, ?, ?, ?)",
    [ctx.job.id, ctx.job.tick, ctx.job.attempt, JSON.stringify(p), ctx.principal.id, ctx.principal.kind, started, Date.now()],
  );
}
"#;

const APP: &str = r#"
import { jobs } from "renox:modules";
export async function GET(ctx) {
  const q = ctx.url.searchParams;
  try {
    if (q.get("enqueue")) {
      const fail = q.get("fail") === "1";
      const id = await ctx.db.transaction(async () => {
        const id = await ctx.jobs.enqueue("report", JSON.parse(q.get("enqueue")));
        if (fail) throw new Error("rolled back");
        return id;
      });
      return Response.json({ id });
    }
    if (q.get("unknown")) return Response.json({ id: await ctx.jobs.enqueue("nope", {}) });
    if (q.get("app_list")) return Response.json(await ctx.jobs.list("queued"));
    if (q.get("list")) return Response.json(await jobs.list(q.get("list")));
    if (q.get("retry")) return Response.json(await jobs.retry(q.get("retry")));
    if (q.get("cancel")) return Response.json(await jobs.cancel(q.get("cancel")));
  } catch (e) {
    return Response.json({ error: e.code ?? e.message, details: e.details ?? null });
  }
  return Response.json({});
}
"#;

/// A stand-in for the `jobs` module's services: the 1.6.0 ops answer only to it.
const JOBS_MODULE: &str = r#"
export async function list(ctx, state) { return ctx.jobs.list(state); }
export async function retry(ctx, id) { return ctx.db.transaction(async () => { await ctx.jobs.retry(id); return "ok"; }); }
export async function cancel(ctx, id) { return ctx.db.transaction(async () => { await ctx.jobs.cancel(id); return "ok"; }); }
"#;

fn module(name: &str, exports: serde_json::Value) -> serde_json::Value {
    let perms = serde_json::json!({ "tables": format!("{name}__*"), "network": [], "secrets": [], "slots": [], "hooks": [] });
    serde_json::json!({
        "name": name, "version": "1.0.0", "hash": "0".repeat(64), "source": format!("path:modules/{name}"),
        "mount": format!("/{name}"), "isolation": "shared", "dependencies": [], "config": {},
        "permissions": perms, "approved": perms, "exports": exports,
    })
}

fn artifact(store: &Path) -> String {
    let tmp = scratch("artifact");
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "jobs", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "jobs/report": "jobs/report.js",
            "modules/jobs/services": "modules/jobs/services.js",
        } },
        "routes": [
            { "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" },
            { "kind": "job", "name": "report", "module": "jobs/report", "schedule": "* * * * *" },
        ],
        "permissions": { "network": [], "secrets": [] },
        "modules": [module("jobs", serde_json::json!({ "services": ["list", "retry", "cancel"] }))],
    });
    let files: Vec<(&str, String)> = vec![
        (
            "manifest.json",
            serde_json::to_string_pretty(&manifest).unwrap(),
        ),
        ("code/functions/f.js", APP.into()),
        ("code/jobs/report.js", REPORT.into()),
        ("code/modules/jobs/services.js", JOBS_MODULE.into()),
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

fn prepare_db(data: &Path) {
    let db = open(data);
    db.execute(
        "create table if not exists app__runs (id text, tick integer, attempt integer, payload text, \
         principal text, kind text, started integer, ended integer)",
        &[],
    )
    .unwrap();
    db.close().unwrap();
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
            ..MeterConfig::new("t_jobs@test", "test", data)
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
    manager.set_outbox_config(OutboxConfig {
        base: Duration::from_millis(20),
        cap: Duration::from_millis(100),
        jitter: 0.2,
        max_attempts: 2,
        ..OutboxConfig::default()
    });
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

    fn job_records(&self) -> Vec<MeterRecord> {
        self.records
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.kind == Some(MeterKind::Job))
            .cloned()
            .collect()
    }
}

#[derive(Debug, Clone)]
struct Run {
    id: String,
    tick: Option<i64>,
    payload: String,
    principal: String,
    kind: String,
    started: i64,
    ended: i64,
}

fn runs(data: &Path) -> Vec<Run> {
    let db = open(data);
    let t = |r: &renox_data::Row, c: &str| match r.get(c) {
        Some(Value::Text(s)) => s.clone(),
        _ => String::new(),
    };
    let i = |r: &renox_data::Row, c: &str| match r.get(c) {
        Some(Value::Integer(n)) => Some(*n),
        _ => None,
    };
    db.query("select * from app__runs order by started", &[])
        .unwrap()
        .iter()
        .map(|r| Run {
            id: t(r, "id"),
            tick: i(r, "tick"),
            payload: t(r, "payload"),
            principal: t(r, "principal"),
            kind: t(r, "kind"),
            started: i(r, "started").unwrap_or(0),
            ended: i(r, "ended").unwrap_or(0),
        })
        .collect()
}

async fn eventually(within: Duration, mut f: impl FnMut() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < within {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
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

fn minute_floor(ms: i64) -> i64 {
    ms - ms.rem_euclid(60_000)
}

/// Three missed ticks of a minutely job (the persisted next tick is three
/// minutes old) become exactly one run, for the latest missed tick, as
/// `Renox::System::"app"`, metered `JOB app report`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missed_ticks_after_downtime_coalesce_into_one_run_as_the_system_principal() {
    let (data, artifacts, hash) = setup();
    let now = jobs::now_ms();
    {
        let db = open(&data);
        jobs::set_next(&db, "app", "report", minute_floor(now) - 3 * 60_000).unwrap();
        db.close().unwrap();
    }
    let n = node(&data, &artifacts, &hash);
    assert_eq!(n.get("").await, serde_json::json!({}), "the cell starts");
    assert!(eventually(Duration::from_secs(10), || runs(&data).len() == 1).await);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = runs(&data);
    assert_eq!(r.len(), 1, "one run for three missed ticks: {r:?}");
    assert_eq!(r[0].tick, Some(minute_floor(now)), "the latest missed tick");
    assert_eq!(r[0].payload, "null", "a scheduled run has no payload");
    assert_eq!(
        (r[0].principal.as_str(), r[0].kind.as_str()),
        ("app", "system")
    );
    assert!(eventually(Duration::from_secs(5), || !n.job_records().is_empty()).await);
    let rec = &n.job_records()[0];
    assert_eq!(rec.route, "JOB app report");
    assert_eq!(rec.request_id, format!("{}_1", r[0].id));
    // The next tick is persisted for the scheduled list and the next start.
    let db = open(&data);
    let next = jobs::stored_next(&db, "app", "report").unwrap().unwrap();
    assert!(next > now && next <= now + 60_000, "{next} {now}");
    assert!(
        jobs::list(&db, &[], "queued", 10, None)
            .unwrap()
            .items
            .is_empty(),
        "acknowledged"
    );
}

/// A tick that arrives while the job runs waits for the run to end: the
/// row stays for the later tick, and the two runs never overlap.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_tick_during_a_run_waits_for_it() {
    let (data, artifacts, hash) = setup();
    let n = node(&data, &artifacts, &hash);
    // A queued run that waits 600 ms holds the job's lease.
    let v = n.get("enqueue=%7B%22spin%22%3A600%7D").await;
    assert!(v["id"].is_string(), "{v}");
    assert!(
        eventually(Duration::from_secs(5), || {
            let db = open(&data);
            !jobs::list(&db, &[], "running", 10, None)
                .unwrap()
                .items
                .is_empty()
        })
        .await
    );
    // Two ticks of the scheduled run arrive meanwhile. They are written
    // from a second connection here, which does not wake the worker the way
    // the cell's own scheduler does, so a committed enqueue wakes it after.
    let t0 = jobs::now_ms();
    {
        let db = open(&data);
        assert!(jobs::schedule_tick(&db, "app", "report", t0, t0).unwrap());
        assert!(!jobs::schedule_tick(&db, "app", "report", t0 + 1, t0 + 1).unwrap());
    }
    let v = n.get("enqueue=%7B%22n%22%3A9%7D").await;
    assert!(v["id"].is_string(), "{v}");
    assert!(
        eventually(Duration::from_secs(10), || runs(&data).len() == 3).await,
        "{:?}",
        runs(&data)
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = runs(&data);
    assert_eq!(r.len(), 3, "{r:?}");
    for w in r.windows(2) {
        assert!(
            w[1].started >= w[0].ended,
            "runs of one job never overlap: {r:?}"
        );
    }
    let scheduled: Vec<&Run> = r.iter().filter(|x| x.payload == "null").collect();
    assert_eq!(scheduled.len(), 1, "one run for both ticks: {r:?}");
    assert_eq!(scheduled[0].tick, Some(t0 + 1), "the later tick");
}

/// `enqueue` writes its row in the caller's transaction: a rollback
/// enqueues nothing; a committed one runs once with its payload. A job the
/// module does not declare is `RENOX_MODULE_UNDECLARED`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enqueue_follows_the_transaction() {
    let (data, artifacts, hash) = setup();
    let n = node(&data, &artifacts, &hash);
    let v = n.get("enqueue=%7B%22n%22%3A1%7D&fail=1").await;
    assert_eq!(v["error"], "rolled back");
    let v = n.get("enqueue=%7B%22n%22%3A2%7D").await;
    let id = v["id"].as_str().unwrap().to_string();
    assert!(eventually(Duration::from_secs(10), || !runs(&data).is_empty()).await);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = runs(&data);
    assert_eq!(r.len(), 1, "{r:?}");
    assert_eq!(
        (r[0].id.as_str(), r[0].payload.as_str(), r[0].tick),
        (id.as_str(), r#"{"n":2}"#, None)
    );
    let v = n.get("unknown=1").await;
    assert_eq!(v["error"], "RENOX_MODULE_UNDECLARED");
    assert_eq!(v["details"]["target"], "job:nope");
}

/// A row left `running` by a dead process is queued again at start and runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_left_running_is_requeued_at_start() {
    let (data, artifacts, hash) = setup();
    let id = {
        let db = open(&data);
        let id = db
            .with_policy(None, || {
                jobs::enqueue(&db, "app", "report", r#"{"n":3}"#, None, 1)
            })
            .unwrap()
            .unwrap();
        jobs::started(&db, &id, 1).unwrap();
        db.close().unwrap();
        id
    };
    let n = node(&data, &artifacts, &hash);
    n.get("").await;
    assert!(eventually(Duration::from_secs(10), || runs(&data).len() == 1).await);
    assert_eq!(runs(&data)[0].id, id);
}

/// The 1.6.0 ops: the app (and any module but `jobs`) gets
/// `RENOX_FORBIDDEN`; the `jobs` module lists a dead run without its
/// payload, retries it with an audit row (`RENOX_JOB_STATE` once it is
/// queued again), and cancels.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_jobs_module_lists_retries_and_cancels_and_no_one_else_can() {
    let (data, artifacts, hash) = setup();
    let n = node(&data, &artifacts, &hash);
    let v = n.get("app_list=1").await;
    assert_eq!(v["error"], "RENOX_FORBIDDEN");
    assert_eq!(v["details"]["action"], "jobs.list");
    // A run that throws twice is dead-lettered (max_attempts = 2).
    let v = n
        .get("enqueue=%7B%22throw%22%3Atrue%2C%22secret%22%3A%22s3cr3t%22%7D")
        .await;
    let id = v["id"].as_str().unwrap().to_string();
    assert!(
        eventually(Duration::from_secs(10), || {
            let db = open(&data);
            !jobs::list(&db, &[], "dead", 10, None)
                .unwrap()
                .items
                .is_empty()
        })
        .await
    );
    let dead = n.get("list=dead").await;
    assert_eq!(dead["items"][0]["id"], id.as_str());
    assert_eq!(dead["items"][0]["name"], "report");
    assert_eq!(dead["items"][0]["attempts"], 2);
    assert!(
        !dead.to_string().contains("s3cr3t"),
        "never the payload: {dead}"
    );
    let scheduled = n.get("list=scheduled").await;
    assert_eq!(scheduled["items"][0]["name"], "report");
    assert!(scheduled["items"][0]["next_at"].is_number());
    // The dead row goes back to the queue (it throws again, which is fine).
    assert_eq!(n.get(&format!("retry={id}")).await, "ok");
    let again = n.get(&format!("retry={id}")).await;
    assert!(
        again["details"]["cause_code"] == "RENOX_JOB_STATE" || again == "ok",
        "queued, running, or dead again by now: {again}"
    );
    assert!(
        eventually(Duration::from_secs(10), || {
            let db = open(&data);
            !jobs::list(&db, &[], "dead", 10, None)
                .unwrap()
                .items
                .is_empty()
        })
        .await
    );
    assert_eq!(n.get(&format!("cancel={id}")).await, "ok");
    let gone = n.get(&format!("cancel={id}")).await;
    // Through the service boundary the caller sees the module's failure
    // with the op's code as its cause.
    assert_eq!(gone["details"]["cause_code"], "RENOX_JOB_NOT_FOUND");
    let db = open(&data);
    let audit: Vec<String> = db
        .with_policy(None, || {
            db.query(
                "select action from renox__authz_audit where action like 'jobs.%' order by id",
                &[],
            )
        })
        .unwrap()
        .unwrap()
        .iter()
        .map(|r| match r.get("action") {
            Some(Value::Text(s)) => s.clone(),
            _ => String::new(),
        })
        .collect();
    assert_eq!(audit.first().map(String::as_str), Some("jobs.retry"));
    assert_eq!(audit.last().map(String::as_str), Some("jobs.cancel"));
}
