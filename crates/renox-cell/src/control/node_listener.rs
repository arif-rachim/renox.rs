//! The node listener (`docs/contracts/deploy-api.md` section 15,
//! `schemas/node-listener.yaml`): the HTTP surface a controlled worker
//! serves to the control plane only, on `[control] node_listen`, a private
//! address. Every request carries `Authorization: Bearer renox_cb_…`, the
//! callback token of the node's current registration (`node_registered`),
//! compared in constant time; anything else is 401.
//!
//! | Path | Issue |
//! | --- | --- |
//! | `POST /nodes/{node}/tenants/{tenant}/restore` | #255 |
//! | `GET /nodes/{node}/tenants/{tenant}/replication` | #255 |
//! | `DELETE /nodes/{node}/tenants/{tenant}` | #257 |
//! | `POST /nodes/{node}/tenants/{tenant}/snapshot`, `PUT …/import` | #258 |
//! | `POST /nodes/{node}/tenants/{tenant}/move` | #259 |

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, Limited};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::cell::valid_tenant_id;
use crate::manager::CellManager;
use crate::replication::{Replication, restore::RestoreError, status};

/// JSON bodies on the node listener are at most 1 MiB (section 1).
const JSON_LIMIT: usize = 1 << 20;

/// The callback token of the current registration. Set by the controller
/// when `node_registered` answers; never logged.
#[derive(Default)]
pub struct CallbackToken(Mutex<Option<String>>);

impl CallbackToken {
    pub fn set(&self, token: Option<String>) {
        *self.0.lock().expect("token lock") = token;
    }

    /// `Authorization: Bearer <token>` matches, in constant time.
    pub fn verify(&self, authorization: Option<&str>) -> bool {
        let Some(presented) = authorization.and_then(|a| a.strip_prefix("Bearer ")) else {
            return false;
        };
        match &*self.0.lock().expect("token lock") {
            Some(t) => {
                t.len() == presented.len() && bool::from(t.as_bytes().ct_eq(presented.as_bytes()))
            }
            None => false,
        }
    }
}

/// What the listener serves from.
pub struct NodeListener {
    pub node_id: String,
    pub token: Arc<CallbackToken>,
    pub replication: Option<Replication>,
    pub manager: CellManager,
    /// `[process] microvm_hook` (#259): run by `POST …/move`.
    pub microvm_hook: Option<std::path::PathBuf>,
}

/// The hook gets at most this long (node-listener.yaml, `nodeMoveTenant`).
pub const MOVE_HOOK_TIMEOUT: Duration = Duration::from_secs(600);
/// `EX_TEMPFAIL`: no hook configured, or the hook timed out.
pub const EX_TEMPFAIL: i32 = 75;

/// Answers are JSON, or a file streamed from disk (`snapshot`).
pub type NodeBody = http_body_util::combinators::BoxBody<Bytes, std::io::Error>;
type Resp = Response<NodeBody>;

fn full(bytes: Bytes) -> NodeBody {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

/// A file read in 64 KiB frames, deleted when the body is dropped.
struct FileBody {
    file: tokio::fs::File,
    path: std::path::PathBuf,
    buf: Vec<u8>,
}

impl hyper::body::Body for FileBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hyper::body::Frame<Bytes>, std::io::Error>>> {
        use tokio::io::AsyncRead;
        let this = &mut *self;
        if this.buf.is_empty() {
            this.buf = vec![0; 64 * 1024];
        }
        let mut rb = tokio::io::ReadBuf::new(&mut this.buf);
        match std::pin::Pin::new(&mut this.file).poll_read(cx, &mut rb) {
            std::task::Poll::Ready(Ok(())) => {
                let n = rb.filled().len();
                if n == 0 {
                    std::task::Poll::Ready(None)
                } else {
                    std::task::Poll::Ready(Some(Ok(hyper::body::Frame::data(
                        Bytes::copy_from_slice(&this.buf[..n]),
                    ))))
                }
            }
            std::task::Poll::Ready(Err(e)) => std::task::Poll::Ready(Some(Err(e))),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

impl Drop for FileBody {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The largest file `import` takes: the paid tier's database quota.
pub const IMPORT_LIMIT: u64 = renox_data::PAID_QUOTA_BYTES;

/// An import refused (`RENOX_IMPORT_REJECTED`, `deploy-api.md` section 14).
fn import_rejected(field: &str, reason: &str) -> Resp {
    error(
        StatusCode::UNPROCESSABLE_ENTITY,
        "RENOX_IMPORT_REJECTED",
        "The database file cannot be imported.",
        Some(json!([{ "field": field, "reason": reason }])),
    )
}

/// Every table, view, index and trigger name follows the authorizer's
/// rules (`<module>__<name>`), or is SQLite's own (`sqlite_…`).
pub fn import_names_ok(names: &[String]) -> Result<Vec<String>, String> {
    let mut tables = Vec::new();
    for n in names {
        if n.starts_with("sqlite_") {
            continue;
        }
        let ok = n.split_once("__").is_some_and(|(m, rest)| {
            !m.is_empty()
                && m.as_bytes()[0].is_ascii_lowercase()
                && m.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                && !rest.is_empty()
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        });
        if !ok {
            return Err(format!("{n} has no <module>__ prefix"));
        }
        tables.push(n.clone());
    }
    Ok(tables)
}

fn json_response(status: StatusCode, body: Value) -> Resp {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(full(Bytes::from(body.to_string())))
        .expect("static response")
}

/// An error body of `deploy-api.md` section 1.
pub fn error(status: StatusCode, code: &str, message: &str, details: Option<Value>) -> Resp {
    let mut id = [0u8; 13];
    let _ = getrandom::fill(&mut id);
    let request_id: String = id.iter().map(|b| format!("{b:02x}")).collect();
    let mut e = json!({ "code": code, "message": message, "request_id": request_id });
    if let Some(d) = details {
        e["details"] = d;
    }
    json_response(status, json!({ "error": e }))
}

fn validation(field: &str, reason: &str) -> Resp {
    error(
        StatusCode::BAD_REQUEST,
        "RENOX_VALIDATION",
        "The request is not valid.",
        Some(json!([{ "field": field, "reason": reason }])),
    )
}

fn backup_unavailable(field: &str, reason: &str) -> Resp {
    let mut r = error(
        StatusCode::SERVICE_UNAVAILABLE,
        "RENOX_BACKUP_UNAVAILABLE",
        "No backup is available for this database right now.",
        Some(json!([{ "field": field, "reason": reason }])),
    );
    r.headers_mut()
        .insert(header::RETRY_AFTER, http::HeaderValue::from_static("30"));
    r
}

fn not_found() -> Resp {
    error(StatusCode::NOT_FOUND, "RENOX_NOT_FOUND", "Not found.", None)
}

/// A database id of `tenant`: the tenant id or `<tenant_id>.<app>`.
pub fn database_of(tenant: &str, database: &str) -> bool {
    if database == tenant {
        return true;
    }
    match database
        .strip_prefix(tenant)
        .and_then(|r| r.strip_prefix('.'))
    {
        Some(app) => {
            !app.is_empty()
                && app.len() <= 50
                && app.as_bytes()[0].is_ascii_lowercase()
                && app
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        }
        None => false,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveRequest {
    #[serde(rename = "type")]
    kind: String,
    schema_version: u32,
    tenant_id: String,
    target: String,
    reason: String,
    operator: String,
}

/// Runs `hook <tenant> <file>` with an empty environment (PATH only) and
/// waits at most `timeout`; the exit code, 75 on a timeout (the hook is
/// killed), 128 + the signal when a signal ended it.
pub fn run_hook(
    hook: &std::path::Path,
    tenant: &str,
    file: &std::path::Path,
    timeout: Duration,
) -> i32 {
    let child = std::process::Command::new(hook)
        .arg(tenant)
        .arg(file)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(tenant_id = tenant, hook = %hook.display(), error = %e, "microvm hook did not start");
            return 127;
        }
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                use std::os::unix::process::ExitStatusExt;
                return status
                    .code()
                    .or_else(|| status.signal().map(|s| 128 + s))
                    .unwrap_or(1);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return EX_TEMPFAIL;
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreRequest {
    #[serde(rename = "type")]
    kind: String,
    schema_version: u32,
    tenant_id: String,
    database: String,
    #[serde(default)]
    source_database: Option<String>,
    timestamp: Option<u64>,
    reason: String,
    deadline_ms: u64,
}

impl NodeListener {
    /// Serves on `addr` until the task is aborted.
    pub async fn serve(
        self: Arc<Self>,
        addr: SocketAddr,
    ) -> std::io::Result<(SocketAddr, JoinHandle<()>)> {
        let listener = TcpListener::bind(addr).await?;
        let local = listener.local_addr()?;
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                };
                let me = self.clone();
                tokio::spawn(async move {
                    let service = hyper::service::service_fn(move |req| {
                        let me = me.clone();
                        async move { Ok::<_, std::convert::Infallible>(me.handle(req).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Ok((local, task))
    }

    /// One request.
    pub async fn handle(&self, req: Request<hyper::body::Incoming>) -> Resp {
        let auth = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());
        if !self.token.verify(auth) {
            return error(
                StatusCode::UNAUTHORIZED,
                "RENOX_UNAUTHENTICATED",
                "Authentication is required.",
                None,
            );
        }
        let path = req.uri().path().to_string();
        let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let (node, tenant, action) = match segs.as_slice() {
            ["nodes", node, "tenants", tenant] => (*node, *tenant, ""),
            ["nodes", node, "tenants", tenant, action] => (*node, *tenant, *action),
            _ => return not_found(),
        };
        if node != self.node_id || !valid_tenant_id(tenant) {
            return not_found();
        }
        let (tenant, method) = (tenant.to_string(), req.method().clone());
        let query = req.uri().query().unwrap_or("").to_string();
        match (method, action) {
            (Method::POST, "restore") => match read_json(req).await {
                Ok(body) => self.restore(&tenant, body).await,
                Err(r) => *r,
            },
            (Method::DELETE, "") => {
                let purge = query_param(&query, "purge_replica").is_some_and(|v| v == "true");
                self.drop_tenant(&tenant, purge).await
            }
            (Method::POST, "move") => match read_json(req).await {
                Ok(body) => self.move_tenant(&tenant, body).await,
                Err(r) => *r,
            },
            (Method::POST, "snapshot") => {
                let database = query_param(&query, "database").unwrap_or_else(|| tenant.clone());
                if !database_of(&tenant, &database) {
                    return validation("database", "not a database of this tenant");
                }
                self.snapshot(&database).await
            }
            (Method::PUT, "import") => {
                let Some(database) = query_param(&query, "database") else {
                    return validation("database", "required");
                };
                if !database_of(&tenant, &database) {
                    return validation("database", "not a database of this tenant");
                }
                if database == tenant {
                    return import_rejected(
                        "database",
                        "the tenant's shared file is never replaced by an import",
                    );
                }
                self.import(&tenant, &database, req).await
            }
            (Method::GET, "replication") => {
                let database = query_param(&query, "database").unwrap_or_else(|| tenant.clone());
                if !database_of(&tenant, &database) {
                    return validation("database", "not a database of this tenant");
                }
                self.replication_status(&tenant, &database)
            }
            _ => not_found(),
        }
    }

    /// #259: marks the tenant moving (its requests answer 503
    /// `RENOX_TENANT_MOVING`), drains its cells, runs `[process]
    /// microvm_hook` with the tenant id and its file, and answers the exit
    /// code. Exit 0 keeps the tenant refused here (it moved; the control
    /// plane republishes its route); anything else lets it serve again.
    async fn move_tenant(&self, tenant: &str, body: Value) -> Resp {
        let req: MoveRequest = match serde_json::from_value(body) {
            Ok(r) => r,
            Err(e) => return validation("body", &e.to_string()),
        };
        if req.kind != "move_request" || req.schema_version != 0 {
            return validation("type", "expected move_request, schema_version 0");
        }
        if req.tenant_id != tenant {
            return validation("tenant_id", "differs from the path");
        }
        if req.target != "microvm" {
            return validation("target", "only microvm");
        }
        let reason_len = req.reason.chars().count();
        if !(10..=500).contains(&reason_len) {
            return validation("reason", "10 to 500 characters");
        }
        if !(req.operator == "operator" || req.operator.starts_with("acct_")) {
            return validation("operator", "operator or an account id");
        }
        if !self.manager.start_moving(tenant) {
            let mut r = error(
                StatusCode::SERVICE_UNAVAILABLE,
                "RENOX_TENANT_MOVING",
                "The service is being moved. Try again shortly.",
                None,
            );
            r.headers_mut()
                .insert(header::RETRY_AFTER, http::HeaderValue::from_static("30"));
            return r;
        }
        let drained = self.manager.drain_tenant(tenant);
        let file = self.manager.config().data_dir.join(tenant).join("app.db");
        let file = std::path::absolute(&file).unwrap_or(file);
        // The reason stays in the control plane's audit row, not here.
        tracing::info!(tenant_id = tenant, operator = %req.operator, cells_drained = drained, "moving the tenant to a microVM");
        let code = match self.microvm_hook.clone() {
            None => EX_TEMPFAIL,
            Some(hook) => {
                let (t, f) = (tenant.to_string(), file.clone());
                tokio::task::spawn_blocking(move || run_hook(&hook, &t, &f, MOVE_HOOK_TIMEOUT))
                    .await
                    .unwrap_or(1)
            }
        };
        let code = code.clamp(0, 255);
        let state = if code == 0 { "moved" } else { "failed" };
        if code != 0 {
            self.manager.stop_moving(tenant);
        }
        tracing::info!(
            tenant_id = tenant,
            hook_exit_code = code,
            state,
            "microVM move ended"
        );
        json_response(
            StatusCode::OK,
            json!({
                "type": "move_result",
                "schema_version": 0,
                "node_id": self.node_id,
                "tenant_id": tenant,
                "target": "microvm",
                "state": state,
                "hook_exit_code": code,
            }),
        )
    }

    /// FO4 (#257): the tenant moved away while this node was gone. Its cells
    /// drain; the node serves only entries that name it, so it refuses the
    /// tenant until one does again. The file is kept (never served from
    /// here) and its sidecar stops after the grace period.
    ///
    /// With `purge_replica` (0.4.1, the erasure of #308): once the cells are
    /// drained and the file is closed (which stops the sidecar after its
    /// last frames), every generation of every database of the tenant is
    /// deleted from the replica store (`replication::purge`). A store that
    /// fails is 503 `RENOX_BACKUP_UNAVAILABLE` and nothing is reported
    /// purged; the control plane retries.
    async fn drop_tenant(&self, tenant: &str, purge: bool) -> Resp {
        let drained = self.manager.drain_tenant(tenant);
        let deadline = Instant::now() + Duration::from_secs(25);
        while self.manager.db_open(tenant) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if purge {
            let purged = match &self.replication {
                Some(r) => {
                    // The sidecar ships its last frames within its grace.
                    tokio::time::sleep(Duration::from_millis(
                        r.section().stop_grace_ms.min(10_000),
                    ))
                    .await;
                    crate::replication::purge::purge(r.section(), tenant).await
                }
                None => Ok(crate::replication::purge::Purged { deleted: 0 }),
            };
            let purged = match purged {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!(tenant_id = tenant, error = %e, "replica purge failed");
                    return backup_unavailable(
                        "replica",
                        "the replica store did not confirm the purge",
                    );
                }
            };
            let at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            tracing::info!(
                tenant_id = tenant,
                cells_drained = drained,
                generations = purged.deleted,
                "tenant dropped and its replica purged (erasure)"
            );
            return json_response(
                StatusCode::OK,
                json!({
                    "type": "tenant_dropped",
                    "schema_version": 0,
                    "node_id": self.node_id,
                    "tenant_id": tenant,
                    "cells_drained": drained,
                    "file": "kept",
                    "replica_generations_deleted": purged.deleted,
                    "replica_purged_at": at,
                }),
            );
        }
        tracing::info!(
            tenant_id = tenant,
            cells_drained = drained,
            "tenant dropped on request of the control plane (moved away)"
        );
        json_response(
            StatusCode::OK,
            json!({
                "type": "tenant_dropped",
                "schema_version": 0,
                "node_id": self.node_id,
                "tenant_id": tenant,
                "cells_drained": drained,
                "file": "kept",
            }),
        )
    }

    /// `VACUUM INTO` a temporary file next to the tenant file (the cells
    /// keep serving), streamed back with its SHA-256; deleted after.
    async fn snapshot(&self, database: &str) -> Resp {
        let dir = self.manager.config().data_dir.join(database);
        let file = dir.join("app.db");
        if !file.exists() {
            return not_found();
        }
        let tmp = dir.join(format!(
            ".snapshot-{}.db",
            std::process::id() as u128 * 1_000_000 + Instant::now().elapsed().as_nanos()
        ));
        let (f, t) = (file.clone(), tmp.clone());
        let made = tokio::task::spawn_blocking(move || -> Result<String, String> {
            let db = renox_data::TenantDb::open(
                &f,
                renox_data::DbOptions {
                    readers: 1,
                    ..Default::default()
                },
            )
            .map_err(|e| e.to_string())?;
            db.execute(
                "vacuum into ?",
                &[renox_data::Value::Text(t.display().to_string())],
            )
            .map_err(|e| e.to_string())?;
            let _ = db.close();
            crate::replication::restore::file_sha256(&t).map_err(|e| e.to_string())
        })
        .await;
        let sha = match made {
            Ok(Ok(s)) => s,
            other => {
                let _ = std::fs::remove_file(&tmp);
                tracing::error!(database, error = ?other.map(|r| r.err()), "snapshot failed");
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "RENOX_INTERNAL",
                    "Internal error. Quote the request id when reporting it.",
                    None,
                );
            }
        };
        let len = std::fs::metadata(&tmp).map_or(0, |m| m.len());
        let f = match tokio::fs::File::open(&tmp).await {
            Ok(f) => f,
            Err(_) => return not_found(),
        };
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/vnd.sqlite3")
            .header(header::CONTENT_LENGTH, len)
            .header(header::CACHE_CONTROL, "no-store")
            .header("x-renox-sha256", sha)
            .body(
                FileBody {
                    file: f,
                    path: tmp,
                    buf: Vec::new(),
                }
                .boxed(),
            )
            .expect("static response")
    }

    /// Writes the upload to a temporary file, checks it (`PRAGMA
    /// quick_check`, the authorizer's naming rules), drains the staging
    /// database's cells and renames the file over it.
    async fn import(
        &self,
        tenant: &str,
        database: &str,
        req: Request<hyper::body::Incoming>,
    ) -> Resp {
        use tokio::io::AsyncWriteExt;
        let dir = self.manager.config().data_dir.join(database);
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            tracing::error!(database, error = %e, "import dir");
            return backup_unavailable("database", "not writable");
        }
        let tmp = dir.join(".import.db");
        let mut out = match tokio::fs::File::create(&tmp).await {
            Ok(f) => f,
            Err(_) => return backup_unavailable("database", "not writable"),
        };
        let mut body = req.into_body();
        let mut size: u64 = 0;
        while let Some(frame) = body.frame().await {
            let Ok(frame) = frame else {
                let _ = std::fs::remove_file(&tmp);
                return validation("body", "the upload was cut off");
            };
            if let Ok(data) = frame.into_data() {
                size += data.len() as u64;
                if size > IMPORT_LIMIT {
                    drop(out);
                    let _ = std::fs::remove_file(&tmp);
                    return error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "RENOX_BODY_TOO_LARGE",
                        "The request body is too large.",
                        None,
                    );
                }
                if out.write_all(&data).await.is_err() {
                    let _ = std::fs::remove_file(&tmp);
                    return backup_unavailable("database", "not writable");
                }
            }
        }
        let _ = out.flush().await;
        drop(out);
        let t = tmp.clone();
        let checked = tokio::task::spawn_blocking(
            move || -> Result<(Vec<String>, String), (String, String)> {
                crate::replication::restore::quick_check(&t)
                    .map_err(|e| ("integrity".to_string(), e))?;
                let db = renox_data::TenantDb::open(
                    &t,
                    renox_data::DbOptions {
                        readers: 1,
                        ..Default::default()
                    },
                )
                .map_err(|e| ("file".to_string(), e.to_string()))?;
                let rows = db
                    .query("select type, name from sqlite_master", &[])
                    .map_err(|e| ("file".to_string(), e.to_string()))?;
                let _ = db.close();
                let text = |r: &renox_data::Row, k: &str| match r.get(k) {
                    Some(renox_data::Value::Text(t)) => Some(t.clone()),
                    _ => None,
                };
                let names: Vec<String> = rows.iter().filter_map(|r| text(r, "name")).collect();
                // Every name is checked (views, indexes and triggers too); the answer lists the tables.
                let checked = import_names_ok(&names).map_err(|e| ("table".to_string(), e))?;
                let tables: Vec<String> = rows
                    .iter()
                    .filter(|r| text(r, "type").as_deref() == Some("table"))
                    .filter_map(|r| text(r, "name"))
                    .filter(|n| checked.contains(n))
                    .collect();
                let sha = crate::replication::restore::file_sha256(&t)
                    .map_err(|e| ("file".to_string(), e.to_string()))?;
                Ok((tables, sha))
            },
        )
        .await;
        let (tables, sha) = match checked {
            Ok(Ok(v)) => v,
            Ok(Err((field, reason))) => {
                let _ = std::fs::remove_file(&tmp);
                return import_rejected(&field, &reason);
            }
            Err(_) => {
                let _ = std::fs::remove_file(&tmp);
                return import_rejected("file", "not a SQLite database");
            }
        };
        // The staging app's cells let go of the old file first.
        self.manager.drain_database(database);
        let deadline = Instant::now() + Duration::from_secs(30);
        while self.manager.db_open(database) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let target = dir.join("app.db");
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", target.display()));
        }
        if std::fs::rename(&tmp, &target).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return backup_unavailable("database", "not writable");
        }
        tracing::info!(tenant_id = tenant, database, size, "database imported");
        json_response(
            StatusCode::OK,
            json!({
                "type": "import_result",
                "schema_version": 0,
                "node_id": self.node_id,
                "tenant_id": tenant,
                "database": database,
                "size_bytes": size,
                "sha256": sha,
                "tables": tables,
            }),
        )
    }

    fn replication_status(&self, tenant: &str, database: &str) -> Resp {
        match &self.replication {
            Some(r) => {
                if !r.file_of(database).exists()
                    && r.state(database) == crate::replication::State::Off
                {
                    let s = r.status(tenant, database);
                    if s["generations"].as_array().is_none_or(Vec::is_empty) {
                        return not_found();
                    }
                    return json_response(StatusCode::OK, s);
                }
                json_response(StatusCode::OK, r.status(tenant, database))
            }
            None => {
                let file = self.manager.config().data_dir.join(database).join("app.db");
                if !file.exists() {
                    return not_found();
                }
                json_response(
                    StatusCode::OK,
                    status::off(&self.node_id, tenant, database, &file),
                )
            }
        }
    }

    async fn restore(&self, tenant: &str, body: Value) -> Resp {
        let req: RestoreRequest = match serde_json::from_value(body) {
            Ok(r) => r,
            Err(e) => return validation("body", &e.to_string()),
        };
        if req.kind != "restore_request" || req.schema_version != 0 {
            return validation("type", "expected restore_request, schema_version 0");
        }
        if req.tenant_id != tenant {
            return validation("tenant_id", "differs from the path");
        }
        if !database_of(tenant, &req.database)
            || req
                .source_database
                .as_deref()
                .is_some_and(|s| !database_of(tenant, s))
        {
            return validation("database", "not a database of this tenant");
        }
        if !["failover", "restore", "move"].contains(&req.reason.as_str())
            || !(1_000..=120_000).contains(&req.deadline_ms)
        {
            return validation("reason", "reason or deadline_ms out of range");
        }
        let Some(replication) = self.replication.clone() else {
            return backup_unavailable("replication", "none");
        };
        // The file is replaced only while no cell of this process holds it.
        let deadline = Instant::now() + Duration::from_millis(req.deadline_ms);
        if req.database == tenant && self.manager.db_open(tenant) {
            self.manager.drain_tenant(tenant);
            while self.manager.db_open(tenant) {
                if Instant::now() >= deadline {
                    return backup_unavailable("database", "still open");
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let database = req.database.clone();
        let source = req.source_database.clone();
        let timestamp = req.timestamp;
        let job = tokio::task::spawn_blocking(move || {
            replication.restore_blocking(&database, source.as_deref(), timestamp)
        });
        let result = match tokio::time::timeout_at(deadline.into(), job).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return backup_unavailable("restore", &e.to_string()),
            Err(_) => return backup_unavailable("restore", "deadline passed"),
        };
        match result {
            Ok(r) => {
                tracing::info!(tenant_id = tenant, database = %req.database, reason = %req.reason, source = r.source, generation = ?r.generation, elapsed_ms = r.elapsed_ms, "restored on request of the control plane");
                json_response(
                    StatusCode::OK,
                    json!({
                        "type": "restore_result",
                        "schema_version": 0,
                        "node_id": self.node_id,
                        "tenant_id": tenant,
                        "database": req.database,
                        "source": r.source,
                        "generation": r.generation,
                        "file_sha256": r.file_sha256,
                        "restored_to": r.restored_to,
                        "elapsed_ms": r.elapsed_ms,
                    }),
                )
            }
            Err(RestoreError::PointUnknown(why)) => error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "RENOX_RESTORE_POINT_UNKNOWN",
                "No backup covers the requested time.",
                Some(json!([{ "field": "timestamp", "reason": why }])),
            ),
            Err(RestoreError::Unavailable(why)) => {
                tracing::error!(tenant_id = tenant, database = %req.database, reason = %why, "restore failed");
                backup_unavailable("replica", "unreachable or empty")
            }
        }
    }
}

fn query_param(query: &str, name: &str) -> Option<String> {
    form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

async fn read_json(req: Request<hyper::body::Incoming>) -> Result<Value, Box<Resp>> {
    let body = Limited::new(req.into_body(), JSON_LIMIT)
        .collect()
        .await
        .map_err(|_| {
            Box::new(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "RENOX_BODY_TOO_LARGE",
                "The request body is too large.",
                None,
            ))
        })?
        .to_bytes();
    serde_json::from_slice(&body).map_err(|_| Box::new(validation("body", "not JSON")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_names_follow_the_authorizer() {
        let ok = |n: &[&str]| import_names_ok(&n.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(
            ok(&["app__notes", "sqlite_autoindex_app__notes_1", "auth__users"]).unwrap(),
            ["app__notes", "auth__users"]
        );
        assert!(ok(&["notes"]).unwrap_err().contains("notes"));
        assert!(ok(&["App__x"]).is_err());
        assert!(ok(&["app__"]).is_err());
    }

    #[test]
    fn databases_belong_to_their_tenant() {
        assert!(database_of("t_a", "t_a"));
        assert!(database_of("t_a", "t_a.hello-restored"));
        assert!(!database_of("t_a", "t_b"));
        assert!(!database_of("t_a", "t_a."));
        assert!(!database_of("t_a", "t_a./x"));
        assert!(!database_of("t_a", "../t_a"));
        assert!(!database_of("t_a", "t_ab"));
    }

    #[test]
    fn the_callback_token_must_match_exactly() {
        let t = CallbackToken::default();
        assert!(!t.verify(Some("Bearer anything")));
        t.set(Some("renox_cb_abcdefghijklmnopqrstuvwxyz234567".into()));
        assert!(t.verify(Some("Bearer renox_cb_abcdefghijklmnopqrstuvwxyz234567")));
        assert!(!t.verify(Some("Bearer renox_cb_abcdefghijklmnopqrstuvwxyz23456")));
        assert!(!t.verify(Some("renox_cb_abcdefghijklmnopqrstuvwxyz234567")));
        assert!(!t.verify(None));
    }
}
