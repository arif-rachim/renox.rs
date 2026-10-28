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
        }
        self.publish();
    }

    /// Applies a delta under rule 1. Returns false when it reveals a gap
    /// (rule 2): the caller fetches a snapshot. A delta no newer than the
    /// table is a late or repeated one: its changes are each checked by
    /// version, and it reveals nothing.
    pub fn apply_delta(&self, delta: Delta) -> bool {
        let (contiguous, changed) = {
            let mut t = self.table.lock().expect("routes lock");
            let newer = delta.version > t.version;
            let contiguous = !newer || delta.prev_version == t.version;
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
            (contiguous, changed || newer)
        };
        if changed {
            self.publish();
        }
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
