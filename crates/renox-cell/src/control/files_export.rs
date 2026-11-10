//! The files export of the node listener (`GET /nodes/{node}/tenants/{tenant}/files`,
//! `deploy-api.md` 0.8 section 15, #670): every stored file of one database
//! as a gzip ustar, written to a temporary file next to the tenant file, no
//! isolate involved.
//!
//! Entries are named `tenants/<tenant_id>/files/<key>` (mode 0644, mtime the
//! row's `created_at`), in key order. A `renox__files` row whose object is
//! gone from the store is skipped and counted. Image variants are derived
//! and not exported.

use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::storage::ObjectStore;

/// The largest export kept on disk (compressed bytes).
pub const MAX_EXPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// What a finished export holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesTarReport {
    pub files: u64,
    pub missing: u64,
    /// SHA-256 (hex) of the compressed file.
    pub sha256: String,
    /// Size of the compressed file.
    pub bytes: u64,
}

#[derive(Debug)]
pub enum FilesExportError {
    /// The temporary file would exceed the limit.
    TooLarge,
    Failed(String),
}

impl<E: std::fmt::Display> From<E> for FilesExportError {
    fn from(e: E) -> Self {
        FilesExportError::Failed(e.to_string())
    }
}

/// `(key, created_at)` of every row of `renox__files`, sorted by key: one
/// read-only transaction.
pub fn collect_file_keys(db_path: &Path) -> Result<Vec<(String, i64)>, String> {
    let db = renox_data::TenantDb::open(
        db_path,
        renox_data::DbOptions {
            readers: 1,
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;
    let rows = db
        .query("select key, created_at from renox__files order by key", &[])
        .map_err(|e| e.to_string());
    let _ = db.close();
    let mut keys = Vec::new();
    for row in rows? {
        match (row.get("key"), row.get("created_at")) {
            (Some(renox_data::Value::Text(k)), Some(renox_data::Value::Integer(t))) => {
                keys.push((k.clone(), *t));
            }
            _ => return Err("renox__files row of an unexpected shape".into()),
        }
    }
    Ok(keys)
}

/// Counts the bytes that reach the file.
struct Counting<W> {
    inner: W,
    n: Arc<AtomicU64>,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let w = self.inner.write(buf)?;
        self.n.fetch_add(w as u64, Ordering::Relaxed);
        Ok(w)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Writes the gzip ustar of `keys` to `out` (blocking; run it on the blocking
/// pool inside a tokio runtime, the store is async).
pub fn write_files_tar(
    store: &dyn ObjectStore,
    tenant_id: &str,
    keys: &[(String, i64)],
    out: &Path,
) -> Result<FilesTarReport, FilesExportError> {
    write_files_tar_capped(store, tenant_id, keys, out, MAX_EXPORT_BYTES)
}

/// [`write_files_tar`] with an explicit limit.
pub fn write_files_tar_capped(
    store: &dyn ObjectStore,
    tenant_id: &str,
    keys: &[(String, i64)],
    out: &Path,
    limit: u64,
) -> Result<FilesTarReport, FilesExportError> {
    let handle = tokio::runtime::Handle::current();
    let written = Arc::new(AtomicU64::new(0));
    let file = std::fs::File::create(out)?;
    let gz = flate2::write::GzEncoder::new(
        Counting {
            inner: std::io::BufWriter::new(file),
            n: written.clone(),
        },
        flate2::Compression::default(),
    );
    let mut builder = tar::Builder::new(gz);
    let (mut files, mut missing) = (0u64, 0u64);
    for (key, created_at) in keys {
        let object = format!("tenants/{tenant_id}/files/{key}");
        let bytes = match handle.block_on(store.get(object.clone())) {
            Ok(Some(b)) => b,
            Ok(None) => {
                missing += 1;
                continue;
            }
            Err(e) => return Err(FilesExportError::Failed(e)),
        };
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_mtime((*created_at / 1000).max(0) as u64);
        builder.append_data(&mut header, &object, &bytes[..])?;
        files += 1;
        if written.load(Ordering::Relaxed) > limit {
            return Err(FilesExportError::TooLarge);
        }
    }
    let gz = builder.into_inner()?;
    let mut counting = gz.finish()?;
    counting.flush()?;
    drop(counting);
    if written.load(Ordering::Relaxed) > limit {
        return Err(FilesExportError::TooLarge);
    }
    let sha256 = crate::replication::restore::file_sha256(out)?;
    let bytes = std::fs::metadata(out)?.len();
    Ok(FilesTarReport {
        files,
        missing,
        sha256,
        bytes,
    })
}
