//! The node's copy of the control plane's route table
//! (`docs/contracts/deploy-api.md` section 8): snapshots and deltas from the
//! control plane, applied to the gateway's [`RouteTable`] (only the entries
//! whose `node_id` is this node, section 7) and to the cell manager
//! (draining). The same entries answer the manager's
//! [`DeploymentLookup`]: tier, app and secret version per deployment.
//!
//! Consistency (#97, section 8 "How a node applies them"):
//!
//! 1. Per `(hostname, deployment_hash)` the node keeps the entry or a
//!    removal tombstone, with its version. An upsert or removal is applied
//!    only if its version is greater than the stored one, so reordered and
//!    duplicated deltas converge.
//! 2. The table version is that of the last snapshot or delta applied. A
//!    newer delta whose `prev_version` differs from it reveals a gap: it is
//!    applied under rule 1 and [`RouteState::apply_delta`] returns false, so
//!    the controller fetches a snapshot.
//! 3. A snapshot replaces the whole table and drops the tombstones. Its
//!    version stays as a floor: a late delta change at or below it is
//!    ignored, because the snapshot already holds its effect (without the
//!    floor, a delta older than the snapshot would bring back an entry the
//!    snapshot no longer has; the convergence test below found it). The
//!    controller fetches a snapshot after registering, on `resync`, after a
//!    gap, and every `resync_interval_ms` with `If-None-Match` (304:
//!    unchanged).
//!
//! Recycling (deploy-api.md sections 8 to 10; #825, #830): a cell is built
//! from what [`DeploymentLookup::lookup`] answers for its deployment. When
//! a snapshot or delta changes that answer's `secrets_version` (rotated
//! secrets) or `module_config` (0.12) for a deployment that had an entry
//! before and still has one, the deployment's
//! cell is recycled ([`CellManager::recycle`]) once the new table is
//! published: the next request gets a fresh cell built from the new entry.
//! A new entry or a removed one is not such a change (a removal drains
//! through [`CellManager::sync_routes`]).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use renox_gateway::{RouteEntry, RouteStatus, RouteTable};
use serde::{Deserialize, Serialize};

use crate::control::degraded::SnapshotFile;
use crate::manager::{CellManager, DeploymentLookup, DeploymentMeta, ModuleConfig};
use crate::process::{ProcessKind, ProcessLookup};
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
    /// 0.3 (#251, #254): `shared` or `own`; missing means `shared`.
    #[serde(default, skip_serializing_if = "ProcessKind::is_shared")]
    pub process: ProcessKind,
    /// 0.3 (#251): the tenant file the entry's cells open; missing means
    /// the tenant's own (`tenant_id`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// 0.5.1 (#346): the tenant's name on a `suspended` entry's page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// 0.12 (#825): per module, config values the platform computes,
    /// merged into `ctx.config` where the artifact leaves a key absent or
    /// `""`; missing means none (older control planes).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub module_config: ModuleConfig,
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

/// `(tenant_id, deployment_hash)`: the deployment a cell serves.
type Deployment = (String, String);

/// The entry [`DeploymentLookup::lookup`] answers for `(tenant_id,
/// deployment_hash)`: the newest one of any hostname.
fn effective<'a>(
    entries: &'a BTreeMap<Key, ControlEntry>,
    tenant_id: &str,
    deployment_hash: &str,
) -> Option<&'a ControlEntry> {
    entries
        .values()
        .filter(|e| e.tenant_id == tenant_id && e.deployment_hash == deployment_hash)
        .max_by_key(|e| e.version)
}

/// What a cell of `e`'s deployment is built from.
fn meta(e: &ControlEntry) -> DeploymentMeta {
    DeploymentMeta {
        tier: e.tier,
        app: Some(e.app.clone()),
        secrets_version: e.secrets_version,
        database: e.database.clone(),
        module_config: e.module_config.clone(),
    }
}

/// Whether a cell built from `before` is stale once `after` is the
/// deployment's entry ([`DeploymentMeta::is_stale_against`]).
fn needs_recycle(before: &ControlEntry, after: &ControlEntry) -> bool {
    meta(before).is_stale_against(&meta(after))
}

/// The deployments of `before` (each with the [`effective`] entry it had)
/// whose effective entry in `entries` [`needs_recycle`]. A deployment
/// without an entry before or after is left out.
fn stale(
    before: impl IntoIterator<Item = (Deployment, Option<ControlEntry>)>,
    entries: &BTreeMap<Key, ControlEntry>,
) -> Vec<Deployment> {
    before
        .into_iter()
        .filter_map(|((tenant, hash), old)| {
            let new = effective(entries, &tenant, &hash)?;
            needs_recycle(old.as_ref()?, new).then_some((tenant, hash))
        })
        .collect()
}

/// Every deployment of `entries` with its [`effective`] entry.
fn effective_all(
    entries: &BTreeMap<Key, ControlEntry>,
) -> BTreeMap<Deployment, Option<ControlEntry>> {
    let mut out: BTreeMap<Deployment, Option<ControlEntry>> = BTreeMap::new();
    for e in entries.values() {
        let slot = out
            .entry((e.tenant_id.clone(), e.deployment_hash.clone()))
            .or_default();
        if slot.as_ref().is_none_or(|s| s.version < e.version) {
            *slot = Some(e.clone());
        }
    }
    out
}

#[derive(Default)]
struct Table {
    /// The route version of the last snapshot or delta applied.
    version: u64,
    entries: BTreeMap<Key, ControlEntry>,
    /// Removals since the last snapshot, with their version (rule 1).
    tombstones: BTreeMap<Key, u64>,
    /// The version of the last snapshot: it stands for every key at that
    /// version, so a change at or below it is already in the table (or was
    /// removed before it) and is ignored.
    floor: u64,
}

impl Table {
    /// The version of what is stored for `key`: entry, tombstone, or the
    /// last snapshot's version.
    fn stored(&self, key: &Key) -> u64 {
        let e = self.entries.get(key).map_or(0, |e| e.version);
        let t = self.tombstones.get(key).copied().unwrap_or(0);
        e.max(t).max(self.floor)
    }
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
    /// `[process] enabled` (#254). Off: an entry's `process = "own"` cannot
    /// be honoured (#403).
    process_enabled: AtomicBool,
    /// Tenants of this node whose active entry asks for `own` while
    /// `[process]` is off, each warned about once.
    own_ignored: Mutex<BTreeSet<String>>,
    /// Every deployment recycled, in order (unit tests have no manager).
    #[cfg(test)]
    recycled: Mutex<Vec<Deployment>>,
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
            process_enabled: AtomicBool::new(false),
            own_ignored: Mutex::new(BTreeSet::new()),
            #[cfg(test)]
            recycled: Mutex::new(Vec::new()),
        }
    }

    /// Whether this worker runs the process tiers (`[process] enabled`).
    pub fn set_process_enabled(&self, enabled: bool) {
        self.process_enabled.store(enabled, Ordering::SeqCst);
        self.check_process_placement();
    }

    /// Whether `[process] enabled` was set (#254).
    pub fn process_enabled(&self) -> bool {
        self.process_enabled.load(Ordering::SeqCst)
    }

    /// #403: the tenants of this node whose active entry asks for
    /// `process = "own"` while `[process]` is off: they run in the shared
    /// process. Empty when the process tiers run.
    pub fn own_process_ignored(&self) -> Vec<String> {
        self.own_ignored
            .lock()
            .expect("routes lock")
            .iter()
            .cloned()
            .collect()
    }

    /// Recomputes [`Self::own_process_ignored`] and logs one warning per
    /// tenant that newly asks for an isolation this worker does not give.
    fn check_process_placement(&self) {
        let wanted: BTreeSet<String> = if self.process_enabled.load(Ordering::SeqCst) {
            BTreeSet::new()
        } else {
            let t = self.table.lock().expect("routes lock");
            t.entries
                .values()
                .filter(|e| {
                    e.node_id == self.node_id
                        && e.status == RouteStatus::Active
                        && e.process == ProcessKind::Own
                })
                .map(|e| e.tenant_id.clone())
                .collect()
        };
        let mut known = self.own_ignored.lock().expect("routes lock");
        for tenant in wanted.difference(&known) {
            tracing::warn!(
                tenant_id = %tenant,
                "route entry asks for process = \"own\" but [process] is off on this worker; the tenant runs in the shared process"
            );
        }
        *known = wanted;
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
        let stale = {
            let mut t = self.table.lock().expect("routes lock");
            let before = effective_all(&t.entries);
            if snapshot.version < t.version {
                tracing::warn!(
                    snapshot = snapshot.version,
                    table = t.version,
                    "route snapshot older than the table; applied as the control plane's truth"
                );
            }
            t.version = snapshot.version;
            t.floor = snapshot.version;
            t.tombstones.clear();
            t.entries = snapshot
                .entries
                .into_iter()
                .map(|e| ((e.hostname.clone(), e.deployment_hash.clone()), e))
                .collect();
            stale(before, &t.entries)
        };
        self.publish();
        self.recycle(stale);
    }

    /// Applies a delta under rule 1. Returns false when it reveals a gap
    /// (rule 2): the caller fetches a snapshot. A delta no newer than the
    /// table is a late or repeated one: its changes are each checked by
    /// version, and it reveals nothing.
    pub fn apply_delta(&self, delta: Delta) -> bool {
        let (contiguous, changed, stale) = {
            let mut t = self.table.lock().expect("routes lock");
            let newer = delta.version > t.version;
            let contiguous = !newer || delta.prev_version == t.version;
            // The deployments this delta can touch, with their entry now.
            let mut touched: BTreeSet<Deployment> = BTreeSet::new();
            let removed = delta
                .removals
                .iter()
                .map(|r| (r.hostname.clone(), r.deployment_hash.clone()));
            let upserted = delta
                .upserts
                .iter()
                .map(|e| (e.hostname.clone(), e.deployment_hash.clone()));
            for key in removed.chain(upserted) {
                if let Some(e) = t.entries.get(&key) {
                    touched.insert((e.tenant_id.clone(), e.deployment_hash.clone()));
                }
            }
            for e in &delta.upserts {
                touched.insert((e.tenant_id.clone(), e.deployment_hash.clone()));
            }
            let before: Vec<(Deployment, Option<ControlEntry>)> = touched
                .into_iter()
                .map(|(tenant, hash)| {
                    let old = effective(&t.entries, &tenant, &hash).cloned();
                    ((tenant, hash), old)
                })
                .collect();
            let mut changed = false;
            for r in delta.removals {
                let key = (r.hostname, r.deployment_hash);
                if r.version > t.stored(&key) {
                    t.entries.remove(&key);
                    t.tombstones.insert(key, r.version);
                    changed = true;
                }
            }
            for e in delta.upserts {
                let key = (e.hostname.clone(), e.deployment_hash.clone());
                if e.version > t.stored(&key) {
                    t.tombstones.remove(&key);
                    t.entries.insert(key, e);
                    changed = true;
                }
            }
            if newer {
                t.version = delta.version;
            }
            let stale = if changed {
                stale(before, &t.entries)
            } else {
                Vec::new()
            };
            (contiguous, changed || newer, stale)
        };
        if changed {
            self.publish();
        }
        self.recycle(stale);
        contiguous
    }

    /// Recycles each deployment whose entry changed what its cell is built
    /// from (module doc, "Recycling"). After [`Self::publish`], so the new
    /// entry is what the fresh cell reads.
    fn recycle(&self, stale: Vec<Deployment>) {
        for (tenant, hash) in stale {
            tracing::info!(tenant_id = %tenant, deployment_hash = %hash, "route entry changed what its cell is built from; recycling the cell");
            if let Some(m) = self.manager.get() {
                m.recycle(&tenant, &hash);
            }
            #[cfg(test)]
            self.recycled
                .lock()
                .expect("routes lock")
                .push((tenant, hash));
        }
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
                display_name: e.display_name.clone(),
                version: Some(e.version),
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
        if let Err(e) = self.gateway.replace(entries.clone()) {
            tracing::error!(error = %e, "route table from the control plane refused; the previous table stays in use");
            return;
        }
        if let Some(m) = self.manager.get() {
            m.sync_routes(&entries);
        }
        self.check_process_placement();
        tracing::debug!(entries = entries.len(), "route table applied");
    }
}

/// #254: a tenant's placement is the `process` of its newest active entry
/// on this node.
impl ProcessLookup for RouteState {
    fn process(&self, tenant_id: &str) -> ProcessKind {
        let t = self.table.lock().expect("routes lock");
        t.entries
            .values()
            .filter(|e| {
                e.tenant_id == tenant_id
                    && e.node_id == self.node_id
                    && e.status == RouteStatus::Active
            })
            .max_by_key(|e| e.version)
            .map_or(ProcessKind::Shared, |e| e.process)
    }
}

impl DeploymentLookup for RouteState {
    fn lookup(&self, tenant_id: &str, deployment_hash: &str) -> DeploymentMeta {
        let t = self.table.lock().expect("routes lock");
        match effective(&t.entries, tenant_id, deployment_hash) {
            Some(e) => meta(e),
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
                database: None,
                module_config: ModuleConfig::new(),
            },
        }
    }

    /// #698: the newest active entry of `(tenant_id, app)` on this node.
    /// A tenant placed in its own process (`process = "own"` with
    /// `[process]` on) is served by its child, not by this process's
    /// cells, so it has none here.
    fn active_deployment(&self, tenant_id: &str, app: &str) -> Option<String> {
        let t = self.table.lock().expect("routes lock");
        let e = t
            .entries
            .values()
            .filter(|e| {
                e.tenant_id == tenant_id
                    && e.app == app
                    && e.node_id == self.node_id
                    && e.status == RouteStatus::Active
            })
            .max_by_key(|e| e.version)?;
        if e.process == ProcessKind::Own && self.process_enabled.load(Ordering::SeqCst) {
            return None;
        }
        Some(e.deployment_hash.clone())
    }
}

#[cfg(test)]
pub(crate) mod tests {
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
            process: ProcessKind::Shared,
            database: None,
            display_name: None,
            module_config: ModuleConfig::new(),
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

    /// #698: `nodeMintAgentToken` finds the app's newest active entry of
    /// this node, only for its own tenant; not another node's, not a
    /// draining one, not one served by its own child process.
    #[test]
    fn the_active_deployment_of_an_app_is_this_nodes_newest_active_entry() {
        let gw = Arc::new(RouteTable::new());
        let s = RouteState::new("node-1", gw);
        let mut other_tenant = entry("x.renox.app", 'x', RouteStatus::Active, "node-1", 1);
        other_tenant.tenant_id = "t_other".into();
        other_tenant.app = "other".into();
        let mut remote = entry("r.renox.app", 'r', RouteStatus::Active, "node-2", 1);
        remote.app = "remote".into();
        s.apply_snapshot(Snapshot {
            version: 3,
            entries: vec![
                entry("a.renox.app", 'a', RouteStatus::Draining, "node-1", 1),
                entry("a.renox.app", 'b', RouteStatus::Active, "node-1", 2),
                other_tenant,
                remote,
            ],
        });
        assert_eq!(
            s.active_deployment("t_hello", "hello"),
            Some("b".repeat(64))
        );
        assert_eq!(s.active_deployment("t_hello", "other"), None);
        assert_eq!(s.active_deployment("t_other", "hello"), None);
        assert_eq!(s.active_deployment("t_hello", "remote"), None);
        let mut own = entry("a.renox.app", 'c', RouteStatus::Active, "node-1", 4);
        own.process = ProcessKind::Own;
        s.apply_snapshot(Snapshot {
            version: 4,
            entries: vec![own],
        });
        assert_eq!(
            s.active_deployment("t_hello", "hello"),
            Some("c".repeat(64))
        );
        s.set_process_enabled(true);
        assert_eq!(s.active_deployment("t_hello", "hello"), None);
    }

    /// #325 (deploy-api.md 0.5.1 section 5): a suspended entry from the
    /// control plane reaches the gateway with its name, and never a cell.
    #[test]
    fn a_suspended_entry_reaches_the_gateway_with_its_name() {
        let gw = Arc::new(RouteTable::new());
        let s = RouteState::new("node-1", gw.clone());
        let json = serde_json::json!({
            "version": 2,
            "entries": [{
                "hostname": "a.renox.app", "tenant_id": "t_hello", "app": "hello",
                "deployment_hash": "a".repeat(64), "status": "suspended", "updated_at": 1,
                "version": 2, "tier": "free", "node_id": "node-1", "secrets_version": 0,
                "display_name": "Hello Shop"
            }]
        });
        s.apply_snapshot(serde_json::from_value(json).unwrap());
        assert!(gw.lookup("a.renox.app").is_none());
        let e = gw.suspended("a.renox.app").unwrap();
        assert_eq!(e.display_name.as_deref(), Some("Hello Shop"));
    }

    /// #403: an entry asking for `own` while `[process]` is off is reported
    /// (and warned about once), so the console does not show an isolation
    /// that does not exist; with `[process]` on, nothing is reported.
    #[test]
    fn own_process_without_the_supervisor_is_reported() {
        let gw = Arc::new(RouteTable::new());
        let s = RouteState::new("node-1", gw);
        let mut own = entry("a.renox.app", 'a', RouteStatus::Active, "node-1", 1);
        own.process = ProcessKind::Own;
        let mut elsewhere = entry("b.renox.app", 'b', RouteStatus::Active, "node-2", 1);
        elsewhere.tenant_id = "t_other".into();
        elsewhere.process = ProcessKind::Own;
        let mut shared = entry("c.renox.app", 'c', RouteStatus::Active, "node-1", 1);
        shared.tenant_id = "t_shared".into();
        s.apply_snapshot(Snapshot {
            version: 1,
            entries: vec![own.clone(), elsewhere, shared],
        });
        assert_eq!(s.own_process_ignored(), vec!["t_hello".to_string()]);
        s.set_process_enabled(true);
        assert!(s.own_process_ignored().is_empty());
        s.set_process_enabled(false);
        assert_eq!(s.own_process_ignored(), vec!["t_hello".to_string()]);
        // Back to shared: no longer reported.
        let mut back = own;
        back.process = ProcessKind::Shared;
        back.version = 2;
        assert!(s.apply_delta(Delta {
            prev_version: 1,
            version: 2,
            upserts: vec![back],
            removals: vec![],
        }));
        assert!(s.own_process_ignored().is_empty());
    }

    fn app_url(url: &str) -> ModuleConfig {
        BTreeMap::from([(
            "email".to_string(),
            BTreeMap::from([("app_url".to_string(), url.to_string())]),
        )])
    }

    fn recycled(s: &RouteState) -> Vec<Deployment> {
        s.recycled.lock().unwrap().clone()
    }

    /// #825 (deploy-api.md 0.12): a delta that changes only the
    /// `module_config` of an active entry recycles that deployment's cell,
    /// and `lookup` answers the new value; a delta that changes only
    /// `updated_at`, a new entry and a removal recycle nothing.
    #[test]
    fn a_module_config_change_recycles_the_deployment() {
        let gw = Arc::new(RouteTable::new());
        let s = RouteState::new("node-1", gw);
        let mut a = entry("a.renox.app", 'a', RouteStatus::Active, "node-1", 1);
        a.module_config = app_url("https://a.renox.app");
        s.apply_snapshot(Snapshot {
            version: 1,
            entries: vec![a.clone()],
        });
        assert!(recycled(&s).is_empty(), "a first entry is not a change");
        let hash_a = "a".repeat(64);
        assert_eq!(
            s.lookup("t_hello", &hash_a).module_config,
            app_url("https://a.renox.app")
        );
        // A custom domain: the platform computes a new app_url.
        let mut changed = a.clone();
        changed.version = 2;
        changed.module_config = app_url("https://shop.example");
        assert!(s.apply_delta(Delta {
            prev_version: 1,
            version: 2,
            upserts: vec![changed.clone()],
            removals: vec![],
        }));
        assert_eq!(recycled(&s), vec![("t_hello".to_string(), hash_a.clone())]);
        assert_eq!(
            s.lookup("t_hello", &hash_a).module_config,
            app_url("https://shop.example")
        );
        // `updated_at` only: nothing the cell is built from.
        let mut touched = changed.clone();
        touched.version = 3;
        touched.updated_at = 99;
        assert!(s.apply_delta(Delta {
            prev_version: 2,
            version: 3,
            upserts: vec![touched],
            removals: vec![],
        }));
        assert_eq!(recycled(&s).len(), 1);
        // A new deployment, then the removal of a draining one: no recycle.
        let mut b = entry("a.renox.app", 'b', RouteStatus::Active, "node-1", 5);
        b.module_config = app_url("https://other.example");
        let mut drained = changed.clone();
        drained.status = RouteStatus::Draining;
        drained.version = 4;
        assert!(s.apply_delta(Delta {
            prev_version: 3,
            version: 5,
            upserts: vec![drained, b],
            removals: vec![],
        }));
        assert!(s.apply_delta(Delta {
            prev_version: 5,
            version: 6,
            upserts: vec![],
            removals: vec![Removal {
                hostname: "a.renox.app".into(),
                deployment_hash: hash_a.clone(),
                version: 6,
            }],
        }));
        assert_eq!(recycled(&s).len(), 1);
        // A late, older delta changes nothing, so it recycles nothing.
        let mut late = entry("a.renox.app", 'b', RouteStatus::Active, "node-1", 5);
        late.module_config = app_url("https://late.example");
        assert!(s.apply_delta(Delta {
            prev_version: 4,
            version: 5,
            upserts: vec![late],
            removals: vec![],
        }));
        assert_eq!(recycled(&s).len(), 1);
        // A snapshot that changes the value recycles as well.
        let mut snap = entry("a.renox.app", 'b', RouteStatus::Active, "node-1", 7);
        snap.module_config = app_url("https://snap.example");
        s.apply_snapshot(Snapshot {
            version: 7,
            entries: vec![snap.clone()],
        });
        assert_eq!(
            recycled(&s).last(),
            Some(&("t_hello".to_string(), "b".repeat(64)))
        );
        assert_eq!(recycled(&s).len(), 2);
        // The same snapshot again: no change.
        s.apply_snapshot(Snapshot {
            version: 7,
            entries: vec![snap],
        });
        assert_eq!(recycled(&s).len(), 2);
    }

    /// #830 (deploy-api.md sections 8 and 9): a delta that raises the active
    /// entry's `secrets_version` recycles the deployment's cell and `lookup`
    /// answers the new version; the same version again recycles nothing.
    #[test]
    fn a_secrets_version_bump_recycles_the_deployment() {
        let gw = Arc::new(RouteTable::new());
        let s = RouteState::new("node-1", gw);
        let hash = "a".repeat(64);
        s.apply_snapshot(Snapshot {
            version: 1,
            entries: vec![entry("a.renox.app", 'a', RouteStatus::Active, "node-1", 1)],
        });
        assert_eq!(s.lookup("t_hello", &hash).secrets_version, 3);
        let mut bumped = entry("a.renox.app", 'a', RouteStatus::Active, "node-1", 2);
        bumped.secrets_version = 4;
        assert!(s.apply_delta(Delta {
            prev_version: 1,
            version: 2,
            upserts: vec![bumped.clone()],
            removals: vec![],
        }));
        assert_eq!(recycled(&s), vec![("t_hello".to_string(), hash.clone())]);
        assert_eq!(s.lookup("t_hello", &hash).secrets_version, 4);
        // Unchanged version (another field moved): no recycle.
        let mut same = bumped.clone();
        same.version = 3;
        same.updated_at = 7;
        assert!(s.apply_delta(Delta {
            prev_version: 2,
            version: 3,
            upserts: vec![same],
            removals: vec![],
        }));
        assert_eq!(recycled(&s).len(), 1);
        // A second hostname of the same deployment (a custom domain) with
        // a newer version: what `lookup` answers changed, so it recycles.
        let mut custom = entry("shop.example", 'a', RouteStatus::Active, "node-1", 4);
        custom.secrets_version = 5;
        assert!(s.apply_delta(Delta {
            prev_version: 3,
            version: 4,
            upserts: vec![custom],
            removals: vec![],
        }));
        assert_eq!(recycled(&s).len(), 2);
        assert_eq!(s.lookup("t_hello", &hash).secrets_version, 5);
    }

    /// #825: a snapshot from a control plane older than deploy-api 0.12 has
    /// no `module_config`; it parses as none, and is not serialized back.
    #[test]
    fn a_snapshot_without_module_config_still_parses() {
        let json = serde_json::json!({
            "version": 2,
            "entries": [{
                "hostname": "a.renox.app", "tenant_id": "t_hello", "app": "hello",
                "deployment_hash": "a".repeat(64), "status": "active", "updated_at": 1,
                "version": 2, "tier": "free", "node_id": "node-1", "secrets_version": 0
            }]
        });
        let snap: Snapshot = serde_json::from_value(json).unwrap();
        assert!(snap.entries[0].module_config.is_empty());
        let back = serde_json::to_value(&snap.entries[0]).unwrap();
        assert!(back.get("module_config").is_none(), "{back}");
        let mut with = snap.entries[0].clone();
        with.module_config = app_url("https://a.renox.app");
        let v = serde_json::to_value(&with).unwrap();
        assert_eq!(
            v["module_config"]["email"]["app_url"],
            "https://a.renox.app"
        );
        let again: ControlEntry = serde_json::from_value(v).unwrap();
        assert_eq!(again, with);
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

/// #97: convergence under loss and reordering.
#[cfg(test)]
mod convergence {
    use super::*;

    /// xorshift64*: deterministic per seed, no dependency.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
        fn chance(&mut self, percent: u64) -> bool {
            self.below(100) < percent
        }
    }

    /// The control plane's table: every change takes the next version, at
    /// most one active entry per hostname (R1), one delta per change set.
    #[derive(Default)]
    struct Server {
        version: u64,
        entries: BTreeMap<Key, ControlEntry>,
    }

    impl Server {
        fn entry(
            &mut self,
            host: &str,
            hash: char,
            status: RouteStatus,
            node: &str,
        ) -> ControlEntry {
            self.version += 1;
            ControlEntry {
                hostname: host.into(),
                tenant_id: "t_x".into(),
                app: "x".into(),
                deployment_hash: hash.to_string().repeat(64),
                status,
                updated_at: self.version,
                version: self.version,
                tier: TierName::Free,
                node_id: node.into(),
                secrets_version: 0,
                process: ProcessKind::Shared,
                database: None,
                display_name: None,
                module_config: ModuleConfig::new(),
            }
        }

        /// One random change set: an activation (new active, old one
        /// draining) or the removal of a draining entry.
        fn change(&mut self, rng: &mut Rng) -> Delta {
            let prev = self.version;
            let host = format!("h{}.renox.app", rng.below(4));
            let hash = (b'a' + rng.below(6) as u8) as char;
            let node = if rng.chance(80) { "node-1" } else { "node-2" };
            let mut upserts = Vec::new();
            let mut removals = Vec::new();
            let draining: Vec<Key> = self
                .entries
                .iter()
                .filter(|(k, e)| k.0 == host && e.status == RouteStatus::Draining)
                .map(|(k, _)| k.clone())
                .collect();
            if !draining.is_empty() && rng.chance(30) {
                let key = draining[rng.below(draining.len() as u64) as usize].clone();
                self.entries.remove(&key);
                self.version += 1;
                removals.push(Removal {
                    hostname: key.0,
                    deployment_hash: key.1,
                    version: self.version,
                });
            } else {
                let key: Key = (host.clone(), hash.to_string().repeat(64));
                let old: Vec<Key> = self
                    .entries
                    .iter()
                    .filter(|(k, e)| k.0 == host && **k != key && e.status == RouteStatus::Active)
                    .map(|(k, _)| k.clone())
                    .collect();
                for k in old {
                    let mut e = self.entries[&k].clone();
                    e = ControlEntry {
                        status: RouteStatus::Draining,
                        ..self.entry(
                            &e.hostname,
                            e.deployment_hash.as_bytes()[0] as char,
                            RouteStatus::Draining,
                            &e.node_id,
                        )
                    };
                    self.entries.insert(k, e.clone());
                    upserts.push(e);
                }
                let e = self.entry(&host, hash, RouteStatus::Active, node);
                self.entries.insert(key, e.clone());
                upserts.push(e);
            }
            Delta {
                prev_version: prev,
                version: self.version,
                upserts,
                removals,
            }
        }

        fn snapshot(&self) -> Snapshot {
            Snapshot {
                version: self.version,
                entries: self.entries.values().cloned().collect(),
            }
        }
    }

    /// The controller's handling of one delivered delta (`control/mod.rs`):
    /// a gap fetches a snapshot at once.
    fn deliver(state: &RouteState, server: &Server, delta: Delta) {
        if !state.apply_delta(delta) {
            state.apply_snapshot(server.snapshot());
        }
    }

    /// Acceptance test of #97: a fake pub/sub that drops 30% of the deltas and
    /// reorders the rest; after one periodic resync (a conditional snapshot:
    /// 304 when the versions match) the node's table equals the control
    /// plane's. 100 runs.
    #[test]
    fn lossy_reordered_deltas_converge_after_one_resync() {
        for seed in 1..=100u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
            let mut server = Server::default();
            let state = RouteState::new("node-1", Arc::new(RouteTable::new()));
            state.apply_snapshot(server.snapshot());
            let mut in_flight: Vec<Delta> = Vec::new();
            for _ in 0..80 {
                let d = server.change(&mut rng);
                if !rng.chance(30) {
                    in_flight.push(d);
                }
                // Deliver some of what is in flight, in random order.
                while !in_flight.is_empty() && rng.chance(50) {
                    let i = rng.below(in_flight.len() as u64) as usize;
                    let d = in_flight.swap_remove(i);
                    deliver(&state, &server, d);
                }
            }
            while !in_flight.is_empty() {
                let i = rng.below(in_flight.len() as u64) as usize;
                let d = in_flight.swap_remove(i);
                deliver(&state, &server, d);
            }
            // One resync interval: `If-None-Match: "<table version>"`.
            if state.version() != server.version {
                state.apply_snapshot(server.snapshot());
            }
            let mut ours = state.entries();
            ours.sort_by(|a, b| {
                (&a.hostname, &a.deployment_hash).cmp(&(&b.hostname, &b.deployment_hash))
            });
            let theirs: Vec<ControlEntry> = server.entries.values().cloned().collect();
            assert_eq!(ours, theirs, "seed {seed}");
            assert_eq!(state.version(), server.version, "seed {seed}");
        }
    }

    /// Rule 1: a delta older than what is stored changes nothing.
    #[test]
    fn an_older_delta_is_ignored() {
        let gw = Arc::new(RouteTable::new());
        let state = RouteState::new("node-1", gw.clone());
        let mut server = Server::default();
        let mut rng = Rng(7);
        let first = server.change(&mut rng);
        let host = first.upserts[0].hostname.clone();
        let old_hash = first.upserts[0].deployment_hash.clone();
        let mut second = Delta {
            prev_version: first.version,
            version: first.version + 1,
            upserts: vec![],
            removals: vec![],
        };
        let mut drained = first.upserts[0].clone();
        drained.status = RouteStatus::Draining;
        drained.version = first.version + 1;
        second.upserts.push(drained);
        assert!(state.apply_delta(first.clone()));
        assert!(state.apply_delta(second));
        // The first delta again (duplicated, late): ignored, no gap.
        assert!(state.apply_delta(first));
        let e = state
            .entries()
            .into_iter()
            .find(|e| e.hostname == host && e.deployment_hash == old_hash)
            .unwrap();
        assert_eq!(e.status, RouteStatus::Draining);
        // A late removal older than the stored entry is ignored as well.
        assert!(state.apply_delta(Delta {
            prev_version: 0,
            version: 1,
            upserts: vec![],
            removals: vec![Removal {
                hostname: host.clone(),
                deployment_hash: old_hash.clone(),
                version: 1
            }],
        }));
        assert!(
            state
                .entries()
                .iter()
                .any(|e| e.hostname == host && e.deployment_hash == old_hash)
        );
    }
}
