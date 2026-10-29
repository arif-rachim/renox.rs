//! `replication_status` of one tenant file (#255, node listener
//! `GET /nodes/{node_id}/tenants/{tenant_id}/replication`,
//! `docs/contracts/deploy-api.md` section 15): the sidecar state, the
//! replica's generations (`litestream generations`), the last sync and the
//! lag, and the size fields of the dashboard's Database header
//! (`docs/19-platform-wireframes.md` 3.8).
//!
//! Litestream 0.3 has no per-database status API without a metrics port
//! per sidecar; `last_sync_at` is the end of the newest generation, and the
//! lag is how far the local file's last write is ahead of it.

use std::time::SystemTime;

use serde_json::{Value, json};

use super::{Replication, State, restore, wal_of};

fn mtime_ms(p: &std::path::Path) -> Option<u64> {
    std::fs::metadata(p)
        .ok()?
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

pub fn status(r: &Replication, tenant_id: &str, database: &str) -> Value {
    let file = r.file_of(database);
    let size = std::fs::metadata(&file).map_or(0, |m| m.len());
    let wal = std::fs::metadata(wal_of(&file)).map_or(0, |m| m.len());
    let section = r.section();
    let gens = r
        .config_for(database)
        .ok()
        .and_then(|cfg| restore::generations(section, &cfg, &file).ok())
        .unwrap_or_default();
    let last_sync = gens.first().map(|g| g.end_ms);
    let last_write = mtime_ms(&wal_of(&file)).max(mtime_ms(&file));
    let lag = match (last_sync, last_write) {
        (Some(s), Some(w)) => Some((w.saturating_sub(s)) as f64 / 1000.0),
        _ => None,
    };
    let state = r.state(database);
    json!({
        "type": "replication_status",
        "schema_version": 0,
        "node_id": r.node_id(),
        "tenant_id": tenant_id,
        "database": database,
        "replication": "litestream",
        "state": if state == State::Off && !gens.is_empty() { "stopped" } else { state.as_str() },
        "replica": r.replica_json(),
        "last_sync_at": last_sync,
        "lag_seconds": lag,
        "retention_hours": section.retention_hours,
        "snapshot_interval_seconds": section.snapshot_interval_secs,
        "generations": gens.iter().take(100).map(|g| json!({ "id": g.id, "start": g.start_ms, "end": g.end_ms })).collect::<Vec<_>>(),
        "db": { "size_bytes": size, "quota_bytes": 0, "wal_bytes": wal },
    })
}

/// The status of a node with replication off.
pub fn off(node_id: &str, tenant_id: &str, database: &str, file: &std::path::Path) -> Value {
    json!({
        "type": "replication_status",
        "schema_version": 0,
        "node_id": node_id,
        "tenant_id": tenant_id,
        "database": database,
        "replication": "none",
        "state": "off",
        "replica": null,
        "last_sync_at": null,
        "lag_seconds": null,
        "retention_hours": 0,
        "snapshot_interval_seconds": 0,
        "generations": [],
        "db": {
            "size_bytes": std::fs::metadata(file).map_or(0, |m| m.len()),
            "quota_bytes": 0,
            "wal_bytes": std::fs::metadata(wal_of(file)).map_or(0, |m| m.len()),
        },
    })
}
