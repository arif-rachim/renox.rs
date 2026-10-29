//! Restore of a tenant file from its replica (#255,
//! `docs/contracts/deploy-api.md` section 15, FO3): `litestream restore`
//! into a temporary file, `PRAGMA quick_check`, rename into place. A local
//! file that fails the check is kept as `<file>.corrupt-<ts>`, never
//! deleted, and never served.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use renox_data::{DbOptions, TenantDb};
use sha2::{Digest, Sha256};

use super::litestream;
use crate::config::ReplicationSection;

/// `PRAGMA quick_check` answered `ok` on every connection.
pub fn quick_check(file: &Path) -> Result<(), String> {
    let db = TenantDb::open(
        file,
        DbOptions {
            readers: 1,
            ..DbOptions::default()
        },
    )
    .map_err(|e| format!("open: {e}"))?;
    let rows = db
        .read_pragma("quick_check")
        .map_err(|e| format!("quick_check: {e}"))?;
    let ok = rows
        .iter()
        .all(|v| matches!(v, renox_data::Value::Text(t) if t == "ok"));
    let _ = db.close();
    if ok {
        Ok(())
    } else {
        Err(format!("quick_check: {rows:?}"))
    }
}

/// SHA-256 of a file, hex.
pub fn file_sha256(file: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(file)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Moves a corrupt file (and its WAL and SHM) aside.
pub fn quarantine(file: &Path, now_ms: u64) -> std::io::Result<PathBuf> {
    let target = PathBuf::from(format!("{}.corrupt-{now_ms}", file.display()));
    std::fs::rename(file, &target)?;
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", file.display()));
        if side.exists() {
            let _ = std::fs::rename(&side, format!("{}{suffix}", target.display()));
        }
    }
    Ok(target)
}

/// What a restore did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restored {
    /// `replica` (restored now) or `local` (the file was there and sound).
    pub source: &'static str,
    pub generation: Option<String>,
    pub file_sha256: String,
    pub restored_to: Option<u64>,
    pub elapsed_ms: u64,
}

/// Why a restore failed (`deploy-api.md` section 15 errors).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreError {
    /// No replica, no generation, the replica unreachable, or Litestream
    /// missing: `RENOX_BACKUP_UNAVAILABLE`.
    Unavailable(String),
    /// No generation covers `timestamp`: `RENOX_RESTORE_POINT_UNKNOWN`.
    PointUnknown(String),
}

impl std::fmt::Display for RestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RestoreError::Unavailable(e) => write!(f, "backup unavailable: {e}"),
            RestoreError::PointUnknown(e) => write!(f, "restore point unknown: {e}"),
        }
    }
}

/// The generations of `source`'s replica, newest first.
pub fn generations(
    r: &ReplicationSection,
    config: &Path,
    source_file: &Path,
) -> Result<Vec<litestream::Generation>, String> {
    let out = Command::new(&r.litestream_bin)
        .arg("generations")
        .arg("-config")
        .arg(config)
        .arg(source_file)
        .output()
        .map_err(|e| format!("run litestream: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "litestream generations: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(litestream::parse_generations(&String::from_utf8_lossy(
        &out.stdout,
    )))
}

/// Restores `target` from the replica of `source` (the same file unless
/// a restore into a new app), as of `timestamp` or the latest state.
/// `config` names `source`'s database. Idempotent: a present `target` that
/// passes the check is kept (`source: local`) when no timestamp is asked.
pub fn restore(
    r: &ReplicationSection,
    config: &Path,
    source_file: &Path,
    target: &Path,
    timestamp: Option<u64>,
    now_ms: u64,
) -> Result<Restored, RestoreError> {
    let started = Instant::now();
    if timestamp.is_none() && target.exists() {
        match quick_check(target) {
            Ok(()) => {
                return Ok(Restored {
                    source: "local",
                    generation: None,
                    file_sha256: file_sha256(target)
                        .map_err(|e| RestoreError::Unavailable(e.to_string()))?,
                    restored_to: None,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
            }
            Err(why) => {
                let moved = quarantine(target, now_ms)
                    .map_err(|e| RestoreError::Unavailable(format!("quarantine: {e}")))?;
                tracing::error!(file = %target.display(), quarantined = %moved.display(), reason = %why, "tenant file failed its check; restoring from the replica");
            }
        }
    }
    let gens = generations(r, config, source_file).map_err(RestoreError::Unavailable)?;
    let Some(newest) = gens.first().cloned() else {
        return Err(RestoreError::Unavailable(
            "the replica has no generation".into(),
        ));
    };
    let chosen = match timestamp {
        None => newest,
        Some(t) => gens
            .iter()
            .find(|g| g.start_ms <= t && t <= g.end_ms)
            .cloned()
            .ok_or_else(|| {
                let oldest = gens.iter().map(|g| g.start_ms).min().unwrap_or(0);
                RestoreError::PointUnknown(format!(
                    "oldest restore point is {oldest}, newest {}",
                    gens[0].end_ms
                ))
            })?,
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| RestoreError::Unavailable(e.to_string()))?;
    }
    let tmp = PathBuf::from(format!("{}.restoring-{now_ms}", target.display()));
    let mut cmd = Command::new(&r.litestream_bin);
    cmd.arg("restore")
        .arg("-config")
        .arg(config)
        .arg("-o")
        .arg(&tmp)
        .arg("-generation")
        .arg(&chosen.id);
    if let Some(t) = timestamp {
        cmd.arg("-timestamp").arg(litestream::ms_rfc3339(t));
    }
    cmd.arg(source_file);
    let out = cmd
        .output()
        .map_err(|e| RestoreError::Unavailable(format!("run litestream: {e}")))?;
    if !out.status.success() || !tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err(RestoreError::Unavailable(format!(
            "litestream restore: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    if let Err(why) = quick_check(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(RestoreError::Unavailable(format!(
            "the restored file failed its check: {why}"
        )));
    }
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", target.display()));
    }
    std::fs::rename(&tmp, target).map_err(|e| RestoreError::Unavailable(e.to_string()))?;
    Ok(Restored {
        source: "replica",
        generation: Some(chosen.id.clone()),
        file_sha256: file_sha256(target).map_err(|e| RestoreError::Unavailable(e.to_string()))?,
        restored_to: Some(timestamp.unwrap_or(chosen.end_ms).min(chosen.end_ms)),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
