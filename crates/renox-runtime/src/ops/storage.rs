//! Storage ops (`docs/contracts/ops.md` 1.7.0 section 21; #321): files in
//! the platform's object store under the tenant's prefix, without a bucket
//! credential in the isolate.
//!
//! | What | Where |
//! | --- | --- |
//! | Key rules and the module prefix (`<module>/…`) | [`check_key`], here |
//! | Type sniffing, `allowed_types`, SVG only sanitised | [`sniff`], [`check_type`], here |
//! | Quota and per-file limit | here, from [`StorageHost::limits`] and the sum of `renox__files` |
//! | The bytes | [`StorageHost`], implemented by the cell (`crates/renox-cell/src/storage.rs`) |
//! | Metadata (`renox__files`) | the tenant's database, through the platform handle |
//!
//! Pure Rust except the ops themselves (feature `v8`).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use bytes::Bytes;
use serde::Serialize;

/// `ops.md` section 21: the key pattern (the module prefix included).
pub const MAX_KEY_LEN: usize = 256;
/// The shortest and longest `op_storage_sign` ttl.
pub const MIN_TTL_SECONDS: u32 = 60;
pub const MAX_TTL_SECONDS: u32 = 604_800;
/// The `op_storage_sign_upload` ttl range and default (`ops.md` section 21).
pub const MIN_UPLOAD_TTL_SECONDS: u32 = 60;
pub const MAX_UPLOAD_TTL_SECONDS: u32 = 3600;

/// A boxed future the host returns; it may run on any runtime.
pub type HostFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

/// The tier's storage limits (*proposed*, Open 21).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorageLimits {
    pub quota_bytes: u64,
    pub file_bytes: u64,
}

impl StorageLimits {
    pub const FREE: StorageLimits = StorageLimits {
        quota_bytes: 1024 * 1024 * 1024,
        file_bytes: 10 * 1024 * 1024,
    };
    pub const PAID: StorageLimits = StorageLimits {
        quota_bytes: 50 * 1024 * 1024 * 1024,
        file_bytes: 100 * 1024 * 1024,
    };
}

/// Where the bytes live: the cell's object store client (S3, or a local
/// directory for `renox dev` and tests). Keys are the full object keys
/// (`tenants/<tenant>/files/<key>`).
pub trait StorageHost: Send + Sync {
    fn put(&self, object: String, bytes: Bytes, content_type: String) -> HostFuture<()>;
    fn get(&self, object: String) -> HostFuture<Option<Bytes>>;
    fn delete(&self, object: String) -> HostFuture<()>;
    /// The hex HMAC of `<path>?exp=<exp>` for a signed URL (`/_files/…`, `/_img/…`).
    fn sign(&self, tenant: &str, path: &str, exp: u64) -> String;
    /// The base64url HMAC-SHA-256 of `PUT /_files/<key>?exp=<exp>&max=<max>&ct=<ct>&pub=<0|1>`
    /// for a signed upload URL; `ct` is the content type as it appears in the URL (urlencoded).
    fn sign_upload(
        &self,
        tenant: &str,
        key: &str,
        exp: u64,
        max: u64,
        ct: &str,
        public: bool,
    ) -> String;
    fn limits(&self, tenant: &str) -> StorageLimits;
    /// Width and height of an image, when the bytes are one the host decodes.
    fn dimensions(&self, bytes: &[u8]) -> Option<(u32, u32)>;
}

/// The object key of a tenant file.
pub fn object_key(tenant: &str, key: &str) -> String {
    format!("tenants/{tenant}/files/{key}")
}

/// One stored file (`ctx.d.ts` `StoredFile`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoredFile {
    pub key: String,
    pub bytes: u64,
    pub content_type: String,
    pub sha256: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub public: bool,
    pub created_at: i64,
}

/// A page of `op_storage_list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StoragePage {
    pub items: Vec<StoredFile>,
    pub next_cursor: Option<String>,
}

/// What a key check refused (`RENOX_STORAGE_KEY`).
pub fn check_key(key: &str, module: &str) -> Result<(), &'static str> {
    if key.is_empty() || key.len() > MAX_KEY_LEN {
        return Err("length");
    }
    let mut chars = key.chars();
    let first = chars.next().unwrap_or(' ');
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err("pattern");
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '/' | '_' | '.' | '-'))
    {
        return Err("pattern");
    }
    if key
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err("segment");
    }
    if !key.starts_with(&format!("{module}/")) {
        return Err("prefix");
    }
    Ok(())
}

/// The content type the first 512 bytes say (`ops.md` section 21, "Sniffing").
pub fn sniff(bytes: &[u8]) -> &'static str {
    let head = &bytes[..bytes.len().min(512)];
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "image/png";
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return "image/webp";
    }
    if head.len() >= 12
        && &head[4..8] == b"ftyp"
        && (&head[8..12] == b"avif" || &head[8..12] == b"avis")
    {
        return "image/avif";
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if head.starts_with(b"%PDF-") {
        return "application/pdf";
    }
    let text = std::str::from_utf8(head).is_ok()
        || std::str::from_utf8(&head[..head.len().saturating_sub(3)]).is_ok();
    if text && !head.contains(&0) {
        let s = String::from_utf8_lossy(head).to_ascii_lowercase();
        let trimmed = s.trim_start_matches('\u{feff}').trim_start();
        if trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && s.contains("<svg")) {
            return "image/svg+xml";
        }
        // A first line of comma-separated fields, the same count on the next.
        let lines: Vec<&str> = s.lines().take(2).collect();
        if lines.len() == 2
            && lines[0].contains(',')
            && lines[0].matches(',').count() == lines[1].matches(',').count()
        {
            return "text/csv";
        }
        return "text/plain";
    }
    "application/octet-stream"
}

/// The platform default of `allowed_types` (`artifact.md` 1.4).
pub const DEFAULT_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/gif",
    "application/pdf",
    "text/plain",
    "text/csv",
];

/// `encodeURIComponent`: what a content type looks like in an upload URL's `ct`.
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Whether `declared` (lower case, no parameters) is in the owner's list (empty: the defaults).
pub fn type_listed(declared: &str, allowed: &[String]) -> bool {
    if allowed.is_empty() {
        DEFAULT_TYPES.contains(&declared)
    } else {
        allowed.iter().any(|t| t == declared)
    }
}

/// Whether a put of `declared` with these bytes is allowed: the declared
/// type in the owner's list, agreeing with the sniffed one (a text type
/// may be declared for text bytes), SVG only when sanitised.
pub fn check_type(
    declared: &str,
    sniffed: &str,
    allowed: &[String],
    sanitised: bool,
) -> Result<(), &'static str> {
    let declared = declared
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !type_listed(&declared, allowed) {
        return Err("not_allowed");
    }
    if declared == "image/svg+xml" {
        if !sanitised {
            return Err("svg_unsanitised");
        }
        return if sniffed == "image/svg+xml" {
            Ok(())
        } else {
            Err("mismatch")
        };
    }
    if sniffed == "image/svg+xml" {
        // SVG bytes declared as anything else: a script carrier in disguise.
        return Err("mismatch");
    }
    let text_like = |t: &str| t.starts_with("text/") || t == "application/json";
    let agrees = declared == sniffed
        || (text_like(&declared) && (sniffed == "text/plain" || sniffed == "text/csv"))
        || (sniffed == "application/octet-stream"
            && !declared.starts_with("image/")
            && declared != "application/pdf");
    if agrees { Ok(()) } else { Err("mismatch") }
}

/// The storage the ops of one isolate use.
pub struct StorageEnv {
    pub host: Option<Arc<dyn StorageHost>>,
    pub tenant_id: String,
    /// Owner (`app` or a module) -> its `[storage] allowed_types` (empty: the defaults).
    pub allowed: std::collections::BTreeMap<String, Vec<String>>,
}

#[cfg(feature = "v8")]
pub(crate) use ops::*;
#[cfg(feature = "v8")]
pub use ops::{StoreError, StoreInput, Stored, store_file};

#[cfg(feature = "v8")]
mod ops {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use deno_core::{JsBuffer, OpState, op2};
    use deno_error::JsErrorBox;
    use renox_data::{DbError, Value};
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::ops::db::{DbEnv, DbHandle};
    use crate::ops::request::{live_request, op_error};

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn owner(module: &Option<String>) -> String {
        module
            .clone()
            .unwrap_or_else(|| crate::ops::modules::APP.to_string())
    }

    fn key_error(key: &str, reason: &str) -> JsErrorBox {
        op_error(
            "RENOX_STORAGE_KEY",
            serde_json::json!({ "key": key, "reason": reason }),
            "The storage key is not allowed.",
        )
    }

    fn not_found(key: &str) -> JsErrorBox {
        op_error(
            "RENOX_STORAGE_NOT_FOUND",
            serde_json::json!({ "key": key }),
            "No stored file has this key.",
        )
    }

    fn unavailable(e: impl std::fmt::Display) -> JsErrorBox {
        tracing::warn!(error = %e, "storage unavailable");
        op_error(
            "RENOX_INTERNAL",
            serde_json::json!({ "reason": "storage" }),
            "The file store is unavailable.",
        )
    }

    fn db_err(e: DbError) -> JsErrorBox {
        unavailable(e)
    }

    struct Envs {
        storage: Rc<StorageEnv>,
        db: Rc<DbEnv>,
    }

    fn envs(state: &Rc<RefCell<OpState>>) -> Envs {
        let s = state.borrow();
        Envs {
            storage: s.borrow::<Rc<StorageEnv>>().clone(),
            db: s.borrow::<Rc<DbEnv>>().clone(),
        }
    }

    fn host(env: &StorageEnv) -> Result<Arc<dyn StorageHost>, JsErrorBox> {
        env.host
            .clone()
            .ok_or_else(|| unavailable("no file store configured"))
    }

    fn row_file(r: &renox_data::Row) -> StoredFile {
        let text = |c: &str| match r.get(c) {
            Some(Value::Text(s)) => s.clone(),
            _ => String::new(),
        };
        let int = |c: &str| match r.get(c) {
            Some(Value::Integer(n)) => Some(*n),
            _ => None,
        };
        StoredFile {
            key: text("key"),
            bytes: int("bytes").unwrap_or(0).max(0) as u64,
            content_type: text("content_type"),
            sha256: text("sha256"),
            width: int("width").map(|n| n as u32),
            height: int("height").map(|n| n as u32),
            public: int("public") == Some(1),
            created_at: int("created_at").unwrap_or(0),
        }
    }

    /// The request's open transaction (a page action holds the writer).
    fn request_tx(state: &Rc<RefCell<OpState>>, token: u32) -> Result<Option<u32>, JsErrorBox> {
        Ok(live_request(&state.borrow(), token)?
            .borrow()
            .resources
            .db_tx)
    }

    async fn file_row(
        state: &Rc<RefCell<OpState>>,
        token: u32,
        key: String,
    ) -> Result<Option<StoredFile>, JsErrorBox> {
        let Envs { db, .. } = envs(state);
        let Some(db) = db.db.clone() else {
            return Ok(None);
        };
        let tx = request_tx(state, token)?;
        db.call_tx(tx, move |db, t| {
            db.with_policy(None, || {
                let sql = "select * from renox__files where key = ?";
                let p = [Value::Text(key)];
                let row = match t {
                    Some(t) => t.query_one(sql, &p),
                    None => db.query_one(sql, &p),
                }?;
                Ok(row.as_ref().map(row_file))
            })?
        })
        .await
        .map_err(db_err)
    }

    async fn stored_total(state: &Rc<RefCell<OpState>>, token: u32) -> Result<u64, JsErrorBox> {
        let Envs { db, .. } = envs(state);
        let Some(db) = db.db.clone() else {
            return Ok(0);
        };
        let tx = request_tx(state, token)?;
        db.call_tx(tx, move |db, t| {
            db.with_policy(None, || {
                let sql = "select coalesce(sum(bytes), 0) as n from renox__files";
                let row = match t {
                    Some(t) => t.query_one(sql, &[]),
                    None => db.query_one(sql, &[]),
                }?;
                Ok(match row.and_then(|r| r.get("n").cloned()) {
                    Some(Value::Integer(n)) => n.max(0) as u64,
                    _ => 0,
                })
            })?
        })
        .await
        .map_err(db_err)
    }

    fn record_total(state: &Rc<RefCell<OpState>>, token: u32, total: u64) {
        if let Ok(r) = live_request(&state.borrow(), token) {
            r.borrow_mut().storage_bytes = Some(total);
        }
    }

    /// What [`store_file`] stores and checks against.
    pub struct StoreInput<'a> {
        pub host: &'a dyn StorageHost,
        pub limits: StorageLimits,
        pub db: &'a DbHandle,
        /// The open transaction of a page action, `None` for autocommit.
        pub tx: Option<u32>,
        pub tenant_id: &'a str,
        /// The owner of the key (`app` or a module); `allowed` is its `allowed_types`.
        pub owner: &'a str,
        pub allowed: &'a [String],
        pub key: &'a str,
        pub bytes: Bytes,
        pub content_type: &'a str,
        pub public: bool,
        pub sanitised: bool,
    }

    /// A stored file and the tenant's stored bytes after it.
    pub struct Stored {
        pub file: StoredFile,
        pub total: u64,
    }

    /// A storage refusal: the `errors.md` code, its details and message.
    #[derive(Debug)]
    pub struct StoreError {
        pub code: &'static str,
        pub details: serde_json::Value,
        pub message: &'static str,
    }

    impl StoreError {
        fn internal(e: impl std::fmt::Display) -> StoreError {
            tracing::warn!(error = %e, "storage unavailable");
            StoreError {
                code: "RENOX_INTERNAL",
                details: serde_json::json!({ "reason": "storage" }),
                message: "The file store is unavailable.",
            }
        }
    }

    /// The checks and writes of `op_storage_put` (per-file limit, sniffing and
    /// type, quota, the object, the `renox__files` upsert), shared with the
    /// cell's `PUT /_files/<key>` (`ops.md` section 21, "Tenant uploads").
    /// The caller has checked the key.
    pub async fn store_file(i: StoreInput<'_>) -> Result<Stored, StoreError> {
        let StoreInput {
            host,
            limits,
            db,
            tx,
            tenant_id,
            owner,
            allowed,
            key,
            bytes,
            content_type,
            public,
            sanitised,
        } = i;
        if bytes.len() as u64 > limits.file_bytes {
            return Err(StoreError {
                code: "RENOX_STORAGE_TOO_LARGE",
                details: serde_json::json!({ "key": key, "bytes": bytes.len(), "limit": limits.file_bytes }),
                message: "The file is over the per-file limit.",
            });
        }
        let sniffed = sniff(&bytes);
        check_type(content_type, sniffed, allowed, sanitised).map_err(|reason| StoreError {
            code: "RENOX_STORAGE_TYPE",
            details: serde_json::json!({ "key": key, "declared": content_type, "sniffed": sniffed, "reason": reason }),
            message: "The content type is not allowed for this file.",
        })?;
        let (previous, total) = {
            let k = key.to_string();
            db.call_tx(tx, move |db, t| {
                db.with_policy(None, || {
                    let sql = "select coalesce((select bytes from renox__files where key = ?), 0) as prev, \
                               coalesce((select sum(bytes) from renox__files), 0) as total";
                    let p = [Value::Text(k)];
                    let row = match t {
                        Some(t) => t.query_one(sql, &p),
                        None => db.query_one(sql, &p),
                    }?;
                    let n = |c: &str| match row.as_ref().and_then(|r| r.get(c)) {
                        Some(Value::Integer(n)) => (*n).max(0) as u64,
                        _ => 0,
                    };
                    Ok((n("prev"), n("total")))
                })?
            })
            .await
            .map_err(StoreError::internal)?
        };
        if total.saturating_sub(previous) + bytes.len() as u64 > limits.quota_bytes {
            return Err(StoreError {
                code: "RENOX_STORAGE_QUOTA",
                details: serde_json::json!({ "key": key, "stored_bytes": total, "limit": limits.quota_bytes }),
                message: "The tenant's storage quota would be exceeded.",
            });
        }
        let content_type = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let (width, height) =
            if content_type.starts_with("image/") && content_type != "image/svg+xml" {
                host.dimensions(&bytes)
                    .map_or((None, None), |(w, h)| (Some(w), Some(h)))
            } else {
                (None, None)
            };
        let file = StoredFile {
            key: key.to_string(),
            bytes: bytes.len() as u64,
            content_type: content_type.clone(),
            sha256: Sha256::digest(&bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            width,
            height,
            public,
            created_at: now_ms(),
        };
        host.put(object_key(tenant_id, key), bytes, content_type)
            .await
            .map_err(StoreError::internal)?;
        let row = file.clone();
        let owner = owner.to_string();
        db.call_tx(tx, move |db, t| {
            db.with_policy(None, || {
                let sql = "insert into renox__files (key, module, bytes, content_type, sha256, width, height, public, created_at) \
                           values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (key) do update set bytes = excluded.bytes, \
                           content_type = excluded.content_type, sha256 = excluded.sha256, width = excluded.width, \
                           height = excluded.height, public = excluded.public, created_at = excluded.created_at";
                let opt = |v: Option<u32>| v.map_or(Value::Null, |n| Value::Integer(i64::from(n)));
                let p = [
                    Value::Text(row.key),
                    Value::Text(owner),
                    Value::Integer(row.bytes as i64),
                    Value::Text(row.content_type),
                    Value::Text(row.sha256),
                    opt(row.width),
                    opt(row.height),
                    Value::Integer(i64::from(row.public)),
                    Value::Integer(row.created_at),
                ];
                match t {
                    Some(t) => t.execute(sql, &p),
                    None => db.execute(sql, &p),
                }
                .map(|_| ())
            })?
        })
        .await
        .map_err(StoreError::internal)?;
        let total = total.saturating_sub(previous) + file.bytes;
        Ok(Stored { file, total })
    }

    #[op2]
    #[serde]
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn op_storage_put(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] key: String,
        #[buffer] bytes: JsBuffer,
        #[string] content_type: String,
        public: bool,
        sanitised: bool,
        #[string] module: Option<String>,
    ) -> Result<StoredFile, JsErrorBox> {
        live_request(&state.borrow(), token)?;
        let owner = owner(&module);
        check_key(&key, &owner).map_err(|r| key_error(&key, r))?;
        let env = envs(&state);
        let host = host(&env.storage)?;
        let limits = host.limits(&env.storage.tenant_id);
        let bytes = Bytes::copy_from_slice(&bytes);
        let Some(db) = env.db.db.clone() else {
            return Err(unavailable("no database"));
        };
        let allowed = env.storage.allowed.get(&owner).cloned().unwrap_or_default();
        let tx = request_tx(&state, token)?;
        let stored = store_file(StoreInput {
            host: host.as_ref(),
            limits,
            db: &db,
            tx,
            tenant_id: &env.storage.tenant_id,
            owner: &owner,
            allowed: &allowed,
            key: &key,
            bytes,
            content_type: &content_type,
            public,
            sanitised,
        })
        .await
        .map_err(|e| op_error(e.code, e.details, e.message))?;
        record_total(&state, token, stored.total);
        Ok(stored.file)
    }

    #[op2]
    #[serde]
    pub(crate) async fn op_storage_get(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] key: String,
        #[string] module: Option<String>,
    ) -> Result<StoredFile, JsErrorBox> {
        live_request(&state.borrow(), token)?;
        check_key(&key, &owner(&module)).map_err(|r| key_error(&key, r))?;
        file_row(&state, token, key.clone())
            .await?
            .ok_or_else(|| not_found(&key))
    }

    #[op2]
    #[buffer]
    pub(crate) async fn op_storage_read(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] key: String,
        #[string] module: Option<String>,
    ) -> Result<Vec<u8>, JsErrorBox> {
        live_request(&state.borrow(), token)?;
        check_key(&key, &owner(&module)).map_err(|r| key_error(&key, r))?;
        if file_row(&state, token, key.clone()).await?.is_none() {
            return Err(not_found(&key));
        }
        let env = envs(&state);
        let host = host(&env.storage)?;
        host.get(object_key(&env.storage.tenant_id, &key))
            .await
            .map_err(unavailable)?
            .map(|b| b.to_vec())
            .ok_or_else(|| not_found(&key))
    }

    #[op2]
    pub(crate) async fn op_storage_delete(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] key: String,
        #[string] module: Option<String>,
    ) -> Result<bool, JsErrorBox> {
        live_request(&state.borrow(), token)?;
        check_key(&key, &owner(&module)).map_err(|r| key_error(&key, r))?;
        if file_row(&state, token, key.clone()).await?.is_none() {
            return Ok(false);
        }
        let env = envs(&state);
        let host = host(&env.storage)?;
        let Some(db) = env.db.db.clone() else {
            return Err(unavailable("no database"));
        };
        let tx = request_tx(&state, token)?;
        let k = key.clone();
        db.call_tx(tx, move |db, t| {
            db.with_policy(None, || {
                let sql = "delete from renox__files where key = ?";
                let p = [Value::Text(k)];
                match t {
                    Some(t) => t.execute(sql, &p),
                    None => db.execute(sql, &p),
                }
                .map(|_| ())
            })?
        })
        .await
        .map_err(db_err)?;
        host.delete(object_key(&env.storage.tenant_id, &key))
            .await
            .map_err(unavailable)?;
        let total = stored_total(&state, token).await?;
        record_total(&state, token, total);
        Ok(true)
    }

    #[derive(Serialize)]
    pub(crate) struct Signed {
        url: String,
        expires_at: u64,
    }

    #[op2]
    #[serde]
    pub(crate) async fn op_storage_sign(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] key: String,
        ttl_seconds: u32,
        #[string] module: Option<String>,
    ) -> Result<Signed, JsErrorBox> {
        live_request(&state.borrow(), token)?;
        if !(MIN_TTL_SECONDS..=MAX_TTL_SECONDS).contains(&ttl_seconds) {
            return Err(JsErrorBox::range_error(format!(
                "storage.sign: ttl is {MIN_TTL_SECONDS} to {MAX_TTL_SECONDS} seconds"
            )));
        }
        check_key(&key, &owner(&module)).map_err(|r| key_error(&key, r))?;
        if file_row(&state, token, key.clone()).await?.is_none() {
            return Err(not_found(&key));
        }
        let env = envs(&state);
        let host = host(&env.storage)?;
        let exp = (now_ms() / 1000) as u64 + u64::from(ttl_seconds);
        let path = format!("/_files/{key}");
        let sig = host.sign(&env.storage.tenant_id, &path, exp);
        Ok(Signed {
            url: format!("{path}?exp={exp}&sig={sig}"),
            expires_at: exp * 1000,
        })
    }

    #[derive(Serialize)]
    pub(crate) struct SignedUpload {
        url: String,
        expires_at: u64,
        max_bytes: u64,
    }

    /// `ctx.storage.signUpload` (`ops.md` section 21, "Tenant uploads"): a URL that accepts
    /// one browser `PUT` of at most `max_bytes` bytes of `content_type`.
    #[op2]
    #[serde]
    pub(crate) async fn op_storage_sign_upload(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] key: String,
        #[string] content_type: String,
        max_bytes: f64,
        ttl_seconds: f64,
        public: bool,
        #[string] module: Option<String>,
    ) -> Result<SignedUpload, JsErrorBox> {
        live_request(&state.borrow(), token)?;
        let (min, max) = (MIN_UPLOAD_TTL_SECONDS, MAX_UPLOAD_TTL_SECONDS);
        if ttl_seconds.fract() != 0.0
            || ttl_seconds < f64::from(min)
            || ttl_seconds > f64::from(max)
        {
            return Err(JsErrorBox::range_error(format!(
                "storage.signUpload: ttl is {min} to {max} seconds"
            )));
        }
        let owner = owner(&module);
        check_key(&key, &owner).map_err(|r| key_error(&key, r))?;
        let env = envs(&state);
        let host = host(&env.storage)?;
        let declared = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let allowed = env.storage.allowed.get(&owner).cloned().unwrap_or_default();
        let refused = if !type_listed(&declared, &allowed) {
            Some("not_allowed")
        } else if declared == "image/svg+xml" {
            // A browser upload is never sanitised (only the storage module's sanitiser sets that).
            Some("svg_unsanitised")
        } else {
            None
        };
        if let Some(reason) = refused {
            return Err(op_error(
                "RENOX_STORAGE_TYPE",
                serde_json::json!({ "key": key, "declared": content_type, "reason": reason }),
                "The content type is not allowed for this file.",
            ));
        }
        let limit = host.limits(&env.storage.tenant_id).file_bytes;
        if max_bytes.fract() != 0.0 || max_bytes < 1.0 || max_bytes > limit as f64 {
            return Err(op_error(
                "RENOX_STORAGE_TOO_LARGE",
                serde_json::json!({ "key": key, "limit_bytes": limit }),
                "The upload limit is over the per-file limit.",
            ));
        }
        let max_bytes = max_bytes as u64;
        let exp = (now_ms() / 1000) as u64 + ttl_seconds as u64;
        // `ct` exactly as the browser will send it back; the signature covers this spelling.
        let ct = encode_component(&content_type);
        let sig = host.sign_upload(&env.storage.tenant_id, &key, exp, max_bytes, &ct, public);
        Ok(SignedUpload {
            url: format!(
                "/_files/{key}?exp={exp}&max={max_bytes}&ct={ct}&pub={}&sig={sig}",
                u8::from(public)
            ),
            expires_at: exp * 1000,
            max_bytes,
        })
    }

    #[op2]
    #[serde]
    pub(crate) async fn op_storage_list(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] prefix: String,
        limit: u32,
        #[string] cursor: Option<String>,
        #[string] module: Option<String>,
    ) -> Result<StoragePage, JsErrorBox> {
        live_request(&state.borrow(), token)?;
        let owner = owner(&module);
        // The caller's prefix only: an empty prefix lists the caller's files.
        let prefix = if prefix.is_empty() {
            format!("{owner}/")
        } else {
            prefix
        };
        if !prefix.starts_with(&format!("{owner}/")) || prefix.contains("..") {
            return Err(key_error(&prefix, "prefix"));
        }
        if !(1..=1000).contains(&limit) {
            return Err(JsErrorBox::range_error("storage.list: limit is 1 to 1000"));
        }
        let env = envs(&state);
        let Some(db) = env.db.db.clone() else {
            return Ok(StoragePage {
                items: Vec::new(),
                next_cursor: None,
            });
        };
        let tx = request_tx(&state, token)?;
        let after = cursor.unwrap_or_default();
        let mut items: Vec<StoredFile> = db
            .call_tx(tx, move |db, t| {
                db.with_policy(None, || {
                    let sql = "select * from renox__files where module = ? and substr(key, 1, length(?)) = ? and key > ? \
                               order by key limit ?";
                    let p = [
                        Value::Text(owner),
                        Value::Text(prefix.clone()),
                        Value::Text(prefix),
                        Value::Text(after),
                        Value::Integer(i64::from(limit) + 1),
                    ];
                    let rows = match t {
                        Some(t) => t.query(sql, &p),
                        None => db.query(sql, &p),
                    }?;
                    Ok(rows.iter().map(row_file).collect())
                })?
            })
            .await
            .map_err(db_err)?;
        let next_cursor = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|f| f.key.clone())
        } else {
            None
        };
        Ok(StoragePage { items, next_cursor })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_confined_to_the_callers_prefix() {
        assert_eq!(check_key("app/photos/a.jpg", "app"), Ok(()));
        assert_eq!(check_key("tax/invoices/1.pdf", "tax"), Ok(()));
        assert_eq!(check_key("tax/invoices/1.pdf", "app"), Err("prefix"));
        assert_eq!(check_key("app/../tax/x", "app"), Err("segment"));
        assert_eq!(check_key("app//x", "app"), Err("segment"));
        assert_eq!(check_key("App/x", "app"), Err("pattern"));
        assert_eq!(check_key("app/x y", "app"), Err("pattern"));
        assert_eq!(
            check_key(&format!("app/{}", "a".repeat(300)), "app"),
            Err("length")
        );
    }

    #[test]
    fn sniffing_decides_from_the_first_bytes() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), "image/png");
        assert_eq!(sniff(b"%PDF-1.7\n"), "application/pdf");
        assert_eq!(
            sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>"),
            "image/svg+xml"
        );
        assert_eq!(sniff(b"a,b,c\n1,2,3\n"), "text/csv");
        assert_eq!(sniff(b"hello"), "text/plain");
        assert_eq!(sniff(&[0, 1, 2, 3]), "application/octet-stream");
    }

    #[test]
    fn types_must_be_allowed_agree_with_the_bytes_and_svg_must_be_sanitised() {
        assert_eq!(check_type("image/jpeg", "image/jpeg", &[], false), Ok(()));
        assert_eq!(
            check_type("image/png", "image/jpeg", &[], false),
            Err("mismatch")
        );
        assert_eq!(
            check_type("text/html", "text/plain", &[], false),
            Err("not_allowed")
        );
        assert_eq!(
            check_type(
                "image/svg+xml",
                "image/svg+xml",
                &["image/svg+xml".into()],
                false
            ),
            Err("svg_unsanitised")
        );
        assert_eq!(
            check_type(
                "image/svg+xml",
                "image/svg+xml",
                &["image/svg+xml".into()],
                true
            ),
            Ok(())
        );
        assert_eq!(
            check_type("text/plain", "image/svg+xml", &[], false),
            Err("mismatch")
        );
        assert_eq!(check_type("text/csv", "text/plain", &[], false), Ok(()));
        assert_eq!(
            check_type(
                "image/jpeg",
                "image/jpeg",
                &["application/pdf".into()],
                false
            ),
            Err("not_allowed")
        );
    }
}
