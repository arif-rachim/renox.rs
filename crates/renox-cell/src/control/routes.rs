//! The node's copy of the control plane's route table
//! (`docs/contracts/deploy-api.md` section 8): snapshots and deltas from the
//! control plane, applied to the gateway's [`RouteTable`] (only the entries
//! whose `node_id` is this node, section 7) and to the cell manager
//! (draining). The same entries answer the manager's
//! [`DeploymentLookup`]: tier, app and secret version per deployment.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use renox_gateway::{RouteEntry, RouteStatus, RouteTable};
use serde::{Deserialize, Serialize};

use crate::control::degraded::SnapshotFile;
use crate::manager::{CellManager, DeploymentLookup, DeploymentMeta};
use crate::tiers::TierName;

/// A route entry with the F3 fields (`control-messages.schema.json`
/// `$defs/route_entry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlEntry {
    pub hostname: String,
    pub tenant_id: String,
    pub app: String,
    pub deployment_hash: String,
    pub status: RouteStatus,
    pub updated_at: u64,
    pub version: u64,
    #[serde(serialize_with = "tier_name")]
    pub tier: TierName,
    pub node_id: String,
    pub secrets_version: u64,
}

fn tier_name<S: serde::Serializer>(t: &TierName, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(match t {
        TierName::Free => "free",
        TierName::Paid => "paid",
    })
}

/// `$defs/route_removal`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Removal {
    pub hostname: String,
    pub deployment_hash: String,
    pub version: u64,
}

/// `$defs/route_snapshot`.
#[derive(Debug, Clone, Deserialize)]
pub struct Snapshot {
    pub version: u64,
    pub entries: Vec<ControlEntry>,
}

/// `$defs/route_delta`.
#[derive(Debug, Clone, Deserialize)]
pub struct Delta {
    pub prev_version: u64,
    pub version: u64,
    pub upserts: Vec<ControlEntry>,
    pub removals: Vec<Removal>,
}

type Key = (String, String);

#[derive(Default)]
struct Table {
    /// The route version of the last snapshot or delta applied.
    version: u64,
    entries: BTreeMap<Key, ControlEntry>,
}

/// The applied route state of this node.
pub struct RouteState {
    node_id: String,
    table: Mutex<Table>,
    gateway: Arc<RouteTable>,
    manager: OnceLock<CellManager>,
    /// Where every applied table is saved (#98).
    snapshot_file: OnceLock<SnapshotFile>,
    /// Deployments being prepared (#96): no route entry names them yet.
    expected: Mutex<HashMap<Key, DeploymentMeta>>,
}

impl RouteState {
    pub fn new(node_id: &str, gateway: Arc<RouteTable>) -> RouteState {
        RouteState {
            node_id: node_id.to_string(),
            table: Mutex::new(Table::default()),
            gateway,
            manager: OnceLock::new(),
            snapshot_file: OnceLock::new(),
            expected: Mutex::new(HashMap::new()),
        }
    }

    /// The manager that drains cells whose entry is no longer active. Set
    /// once, after the manager is built (it needs this state as its lookup).
    pub fn set_manager(&self, manager: CellManager) {
        let _ = self.manager.set(manager);
    }

    /// What a deployment being prepared (#96) needs at cell creation, until
    /// a route entry names it.
    pub fn expect(&self, tenant_id: &str, deployment_hash: &str, meta: DeploymentMeta) {
        self.expected
            .lock()
            .expect("routes lock")
            .insert((tenant_id.to_string(), deployment_hash.to_string()), meta);
    }

    fn is_expected(&self, tenant_id: &str, deployment_hash: &str) -> bool {
        self.expected
            .lock()
            .expect("routes lock")
            .contains_key(&(tenant_id.to_string(), deployment_hash.to_string()))
    }

    /// Drains every cell without an active entry of this node (a prepared
    /// cell whose route delta never came, #96 step 7).
    pub fn sync_manager(&self) {
        if let Some(m) = self.manager.get() {
            m.sync_routes(&self.gateway_entries());
        }
    }

    /// Saves every applied table to `file` from now on (degraded mode, #98).
    pub fn persist_to(&self, file: SnapshotFile) {
        let _ = self.snapshot_file.set(file);
    }

    /// The route version of the last snapshot or delta applied.
    pub fn version(&self) -> u64 {
        self.table.lock().expect("routes lock").version
    }

    /// Every entry, all nodes (tests, degraded-mode snapshot).
    pub fn entries(&self) -> Vec<ControlEntry> {
        self.table
            .lock()
            .expect("routes lock")
            .entries
            .values()
            .cloned()
            .collect()
    }

    /// Replaces the whole table.
    pub fn apply_snapshot(&self, snapshot: Snapshot) {
        {
            let mut t = self.table.lock().expect("routes lock");
            t.version = snapshot.version;
            t.entries = snapshot
                .entries
                .into_iter()
                .map(|e| ((e.hostname.clone(), e.deployment_hash.clone()), e))
                .collect();
        }
        self.publish();
    }

    /// Applies a delta. Returns false when its `prev_version` is not the
    /// table's version (a gap): the caller fetches a snapshot.
    pub fn apply_delta(&self, delta: Delta) -> bool {
        let contiguous = {
            let mut t = self.table.lock().expect("routes lock");
            let contiguous = delta.prev_version == t.version;
            for r in delta.removals {
                t.entries.remove(&(r.hostname, r.deployment_hash));
            }
            for e in delta.upserts {
                t.entries
                    .insert((e.hostname.clone(), e.deployment_hash.clone()), e);
            }
            t.version = t.version.max(delta.version);
            contiguous
        };
        self.publish();
        contiguous
    }

    /// The entries of this node, as the gateway's route table file.
    fn gateway_entries(&self) -> Vec<RouteEntry> {
        let t = self.table.lock().expect("routes lock");
        t.entries
            .values()
            .filter(|e| e.node_id == self.node_id)
            .map(|e| RouteEntry {
                hostname: e.hostname.clone(),
                tenant_id: e.tenant_id.clone(),
                deployment_hash: e.deployment_hash.clone(),
                status: e.status,
                updated_at: e.updated_at,
            })
            .collect()
    }

    /// Pushes this node's entries to the gateway and the manager. A table
    /// the gateway refuses (two active entries for one hostname) leaves the
    /// previous gateway table in use.
    fn publish(&self) {
        if let Some(file) = self.snapshot_file.get() {
            let (version, all) = {
                let t = self.table.lock().expect("routes lock");
                (t.version, t.entries.values().cloned().collect::<Vec<_>>())
            };
            file.save(version, &all);
        }
        let entries = self.gateway_entries();
        let json = serde_json::json!({ "version": 0, "entries": entries }).to_string();
        if let Err(e) = self.gateway.reload_from_json(&json) {
            tracing::error!(error = %e, "route table from the control plane refused; the previous table stays in use");
            return;
        }
        if let Some(m) = self.manager.get() {
            m.sync_routes(&entries);
        }
        tracing::debug!(entries = entries.len(), "route table applied");
    }
}

impl DeploymentLookup for RouteState {
    fn lookup(&self, tenant_id: &str, deployment_hash: &str) -> DeploymentMeta {
        let t = self.table.lock().expect("routes lock");
        let found = t
            .entries
            .values()
            .filter(|e| e.tenant_id == tenant_id && e.deployment_hash == deployment_hash)
            .max_by_key(|e| e.version);
        match found {
            Some(e) => DeploymentMeta {
                tier: e.tier,
                app: Some(e.app.clone()),
                secrets_version: e.secrets_version,
            },
            // Being prepared (#96): what the prepare message said.
            None if self.is_expected(tenant_id, deployment_hash) => self
                .expected
                .lock()
                .expect("routes lock")
                .get(&(tenant_id.to_string(), deployment_hash.to_string()))
                .cloned()
                .expect("checked above"),
            // No entry: the request could not have been routed here; the
            // most restrictive tier is the safe answer.
            None => DeploymentMeta {
                tier: TierName::Free,
                app: None,
                secrets_version: 0,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn entry(
        host: &str,
        hash: char,
        status: RouteStatus,
        node: &str,
        version: u64,
    ) -> ControlEntry {
        ControlEntry {
            hostname: host.into(),
            tenant_id: "t_hello".into(),
            app: "hello".into(),
            deployment_hash: hash.to_string().repeat(64),
            status,
            updated_at: 1,
            version,
            tier: TierName::Paid,
            node_id: node.into(),
            secrets_version: 3,
        }
    }

    #[test]
    fn only_this_nodes_entries_reach_the_gateway() {
        let gw = Arc::new(RouteTable::new());
        let s = RouteState::new("node-1", gw.clone());
        s.apply_snapshot(Snapshot {
            version: 5,
            entries: vec![
                entry("a.renox.app", 'a', RouteStatus::Active, "node-1", 4),
                entry("b.renox.app", 'b', RouteStatus::Active, "node-2", 5),
            ],
        });
        assert_eq!(s.version(), 5);
        assert!(gw.lookup("a.renox.app").is_some());
        assert!(gw.lookup("b.renox.app").is_none());
        let meta = s.lookup("t_hello", &"a".repeat(64));
        assert_eq!(meta.tier, TierName::Paid);
        assert_eq!(meta.app.as_deref(), Some("hello"));
        assert_eq!(meta.secrets_version, 3);
        assert_eq!(s.lookup("t_other", &"a".repeat(64)).tier, TierName::Free);
    }

    #[test]
    fn deltas_switch_and_report_gaps() {
        let gw = Arc::new(RouteTable::new());
        let s = RouteState::new("node-1", gw.clone());
        s.apply_snapshot(Snapshot {
            version: 1,
            entries: vec![entry("a.renox.app", 'a', RouteStatus::Active, "node-1", 1)],
        });
        assert!(s.apply_delta(Delta {
            prev_version: 1,
            version: 3,
            upserts: vec![
                entry("a.renox.app", 'a', RouteStatus::Draining, "node-1", 2),
                entry("a.renox.app", 'b', RouteStatus::Active, "node-1", 3),
            ],
            removals: vec![],
        }));
        assert_eq!(
            gw.lookup("a.renox.app").unwrap().deployment_hash,
            "b".repeat(64)
        );
        assert!(!s.apply_delta(Delta {
            prev_version: 7,
            version: 8,
            upserts: vec![],
            removals: vec![Removal {
                hostname: "a.renox.app".into(),
                deployment_hash: "a".repeat(64),
                version: 8,
            }],
        }));
        assert_eq!(gw.entries("a.renox.app").len(), 1);
    }
}
