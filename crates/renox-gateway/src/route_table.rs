//! In-memory route table: hostname → tenant → deployment.
//!
//! Contract: `docs/contracts/artifact.md` section 5 and
//! `docs/contracts/schemas/route-table.schema.json`.
//!
//! # Read path
//!
//! The table is an `ArcSwap<HashMap<..>>`. A lookup loads the current map
//! with `ArcSwap::load` (an atomic pointer load plus a debt-list slot, no lock
//! and no reference-count contention between readers) and does one hash-map
//! read. Writers never mutate the published map: they clone it, change the
//! clone, and publish it with a compare-and-swap (`ArcSwap::rcu`). A request
//! therefore always sees one consistent table, either the one before or the
//! one after a write, and writers never block readers.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};

/// Status of a route table entry (`artifact.md` section 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteStatus {
    /// Receives new requests.
    Active,
    /// A superseded deployment that finishes its in-flight requests and is
    /// then evicted. Kept in the table, never chosen for a new request.
    Draining,
    /// The tenant is suspended (`artifact.md` 1.5): the hostname is answered
    /// with the neutral suspension page, never routed to a cell.
    Suspended,
}

/// One route table entry (`artifact.md` section 5).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteEntry {
    pub hostname: String,
    pub tenant_id: String,
    pub deployment_hash: String,
    pub status: RouteStatus,
    /// Unix time in milliseconds.
    pub updated_at: u64,
    /// The tenant's name on the suspension page (`artifact.md` 1.5);
    /// suspended entries only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// The control plane's route version that last wrote this entry
    /// (`docs/contracts/deploy-api.md` section 8, #97). `None` in a local
    /// route table file, which stays `artifact.md` version 0 and never
    /// carries it.
    #[serde(skip)]
    pub version: Option<u64>,
}

/// The on-disk route table file (F1: a local JSON file).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteTableFile {
    #[serde(rename = "$comment")]
    #[allow(dead_code)]
    comment: Option<String>,
    version: u32,
    entries: Vec<RouteEntry>,
}

/// Why a route table entry or file was refused. Messages name the rule and
/// the field, never a filesystem path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteTableError {
    /// The file is not valid JSON or does not match the schema shape.
    Parse(String),
    /// `version` is not `0`.
    UnknownVersion(u32),
    /// A field does not match its pattern.
    InvalidField { field: &'static str, value: String },
    /// V13: more than one `active` entry for a hostname.
    DuplicateActive(String),
    /// V13 (1.5): a hostname has both a `suspended` and an `active` entry.
    SuspendedAndActive(String),
    /// V13 (1.5): `display_name` on an entry that is not `suspended`.
    DisplayNameNotSuspended(String),
    /// V13: `(hostname, deployment_hash)` appears twice.
    DuplicateEntry {
        hostname: String,
        deployment_hash: String,
    },
}

impl fmt::Display for RouteTableError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(e) => write!(f, "V13: route table does not parse: {e}"),
            Self::UnknownVersion(v) => write!(f, "V13: unknown route table version {v}"),
            Self::InvalidField { field, value } => {
                write!(f, "V13: invalid {field} {value:?}")
            }
            Self::DuplicateActive(h) => write!(f, "V13: more than one active entry for {h}"),
            Self::SuspendedAndActive(h) => write!(f, "V13: {h} is both suspended and active"),
            Self::DisplayNameNotSuspended(h) => {
                write!(
                    f,
                    "V13: display_name on an entry of {h} that is not suspended"
                )
            }
            Self::DuplicateEntry {
                hostname,
                deployment_hash,
            } => write!(f, "V13: duplicate entry ({hostname}, {deployment_hash})"),
        }
    }
}

impl std::error::Error for RouteTableError {}

/// All entries of one hostname: at most one active, any number draining.
#[derive(Clone, Debug, Default)]
struct HostRoutes {
    entries: Vec<RouteEntry>,
}

impl HostRoutes {
    fn active(&self) -> Option<&RouteEntry> {
        self.entries
            .iter()
            .find(|e| e.status == RouteStatus::Active)
    }

    fn suspended(&self) -> Option<&RouteEntry> {
        self.entries
            .iter()
            .find(|e| e.status == RouteStatus::Suspended)
    }
}

type Map = HashMap<String, HostRoutes>;

/// Hostname → route entries, lock-free on the read path (see module docs).
#[derive(Default)]
pub struct RouteTable {
    map: ArcSwap<Map>,
}

impl fmt::Debug for RouteTable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RouteTable")
            .field("hostnames", &self.map.load().len())
            .finish()
    }
}

impl RouteTable {
    /// An empty table: every host is unknown.
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds a table from a route table file (V13). Fails as a whole.
    pub fn from_json(json: &str) -> Result<Self, RouteTableError> {
        let table = Self::new();
        table.reload_from_json(json)?;
        Ok(table)
    }

    /// Replaces the whole table with the contents of a route table file.
    /// A file that fails validation is refused as a whole and the previous
    /// table stays in use (`artifact.md` section 5, F1 rule).
    pub fn reload_from_json(&self, json: &str) -> Result<(), RouteTableError> {
        let file: RouteTableFile =
            serde_json::from_str(json).map_err(|e| RouteTableError::Parse(e.to_string()))?;
        if file.version != 0 {
            return Err(RouteTableError::UnknownVersion(file.version));
        }
        self.replace(file.entries)
    }

    /// Replaces the whole table with `entries` (a control-plane snapshot,
    /// #97). Validated like a file (V13); refused as a whole.
    pub fn replace(&self, entries: Vec<RouteEntry>) -> Result<(), RouteTableError> {
        let mut map = Map::new();
        for entry in entries {
            validate_entry(&entry)?;
            let host = map.entry(entry.hostname.clone()).or_default();
            if host
                .entries
                .iter()
                .any(|e| e.deployment_hash == entry.deployment_hash)
            {
                return Err(RouteTableError::DuplicateEntry {
                    hostname: entry.hostname,
                    deployment_hash: entry.deployment_hash,
                });
            }
            if entry.status == RouteStatus::Active && host.active().is_some() {
                return Err(RouteTableError::DuplicateActive(entry.hostname));
            }
            let (a, b) = (entry.status, host.active().is_some());
            if (a == RouteStatus::Active && host.suspended().is_some())
                || (a == RouteStatus::Suspended && b)
            {
                return Err(RouteTableError::SuspendedAndActive(entry.hostname));
            }
            host.entries.push(entry);
        }
        self.map.store(Arc::new(map));
        Ok(())
    }

    /// Inserts or replaces the entry for `(hostname, deployment_hash)`.
    ///
    /// Upserting an `active` entry is a deployment switch: the hostname's
    /// previous active entry, if any, becomes `draining`, so the table keeps
    /// at most one active entry per hostname.
    ///
    /// When both the stored entry and `entry` carry a route version, an
    /// `entry` that is not newer is ignored (#97: reordered or replayed
    /// control-plane deltas never undo a newer change). Returns whether the
    /// table changed.
    pub fn upsert(&self, entry: RouteEntry) -> Result<bool, RouteTableError> {
        validate_entry(&entry)?;
        let mut applied = true;
        self.map.rcu(|current| {
            let mut map = Map::clone(current);
            let host = map.entry(entry.hostname.clone()).or_default();
            let stale = host.entries.iter().any(|e| {
                e.deployment_hash == entry.deployment_hash
                    && matches!((e.version, entry.version), (Some(old), Some(new)) if new <= old)
            });
            applied = !stale;
            if stale {
                return map;
            }
            if entry.status == RouteStatus::Active {
                for e in &mut host.entries {
                    if e.status == RouteStatus::Active && e.deployment_hash != entry.deployment_hash
                    {
                        e.status = RouteStatus::Draining;
                    }
                }
                // A reinstated hostname: its suspension ends with the switch.
                host.entries.retain(|e| {
                    e.status != RouteStatus::Suspended || e.deployment_hash == entry.deployment_hash
                });
            }
            if entry.status == RouteStatus::Suspended {
                // In-flight requests finish; no new one reaches the cell.
                for e in &mut host.entries {
                    if e.status == RouteStatus::Active {
                        e.status = RouteStatus::Draining;
                    }
                }
            }
            match host
                .entries
                .iter_mut()
                .find(|e| e.deployment_hash == entry.deployment_hash)
            {
                Some(existing) => *existing = entry.clone(),
                None => host.entries.push(entry.clone()),
            }
            map
        });
        Ok(applied)
    }

    /// Removes every entry of `hostname`. Returns whether anything was removed.
    pub fn remove(&self, hostname: &str) -> bool {
        let mut removed = false;
        self.map.rcu(|current| {
            let mut map = Map::clone(current);
            removed = map.remove(hostname).is_some();
            map
        });
        removed
    }

    /// Removes one `(hostname, deployment_hash)` entry, for example a
    /// draining deployment that has finished. Returns whether it existed.
    pub fn remove_deployment(&self, hostname: &str, deployment_hash: &str) -> bool {
        let mut removed = false;
        self.map.rcu(|current| {
            let mut map = Map::clone(current);
            removed = false;
            if let Some(host) = map.get_mut(hostname) {
                let before = host.entries.len();
                host.entries
                    .retain(|e| e.deployment_hash != deployment_hash);
                removed = host.entries.len() != before;
                if host.entries.is_empty() {
                    map.remove(hostname);
                }
            }
            map
        });
        removed
    }

    /// The entry that serves new requests for `host`: the hostname's active
    /// entry. `host` is a normalised hostname (see [`parse_host`]). A
    /// hostname with no entry, or whose entries are all draining, returns
    /// `None` and is answered like an unknown host.
    pub fn lookup(&self, host: &str) -> Option<RouteEntry> {
        self.map.load().get(host)?.active().cloned()
    }

    /// The `suspended` entry of `host`, if the hostname is suspended
    /// (`artifact.md` 1.5): answered with the neutral page, never routed.
    pub fn suspended(&self, host: &str) -> Option<RouteEntry> {
        self.map.load().get(host)?.suspended().cloned()
    }

    /// Every entry of `host`, active and draining.
    pub fn entries(&self, host: &str) -> Vec<RouteEntry> {
        self.map
            .load()
            .get(host)
            .map(|h| h.entries.clone())
            .unwrap_or_default()
    }

    /// Number of hostnames in the table.
    pub fn len(&self) -> usize {
        self.map.load().len()
    }

    /// Whether the table has no hostnames.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn validate_entry(entry: &RouteEntry) -> Result<(), RouteTableError> {
    if let Some(name) = &entry.display_name {
        if entry.status != RouteStatus::Suspended {
            return Err(RouteTableError::DisplayNameNotSuspended(
                entry.hostname.clone(),
            ));
        }
        let n = name.chars().count();
        if n == 0 || n > 128 {
            return Err(RouteTableError::InvalidField {
                field: "display_name",
                value: name.clone(),
            });
        }
    }
    if !is_valid_table_hostname(&entry.hostname) {
        return Err(RouteTableError::InvalidField {
            field: "hostname",
            value: entry.hostname.clone(),
        });
    }
    if !is_valid_tenant_id(&entry.tenant_id) {
        return Err(RouteTableError::InvalidField {
            field: "tenant_id",
            value: entry.tenant_id.clone(),
        });
    }
    if !is_sha256_hex(&entry.deployment_hash) {
        return Err(RouteTableError::InvalidField {
            field: "deployment_hash",
            value: entry.deployment_hash.clone(),
        });
    }
    Ok(())
}

/// `^[a-z0-9][a-z0-9_-]{0,62}$`
fn is_valid_tenant_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

/// 64 lower-case hex characters.
pub(crate) fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// One DNS label: `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`.
fn is_valid_label(label: &str) -> bool {
    let b = label.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
        && b.iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// A hostname as the schema allows it in the table: at least two labels.
fn is_valid_table_hostname(s: &str) -> bool {
    s.len() <= 253 && s.contains('.') && s.split('.').all(is_valid_label)
}

/// Why a request's host could not be parsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostError {
    /// No `Host` header and no authority in the request URI.
    Missing,
    /// Not a valid DNS hostname (bad characters, IP literal, bad port).
    Invalid,
}

/// Normalises a `Host` header value (or URI authority) the way the route
/// table is keyed: removes the port and a trailing dot, lower-cases, and
/// rejects anything that is not a DNS hostname (`artifact.md` section 5).
/// IP literals (`[::1]`) and user info are rejected.
pub fn parse_host(raw: &str) -> Result<String, HostError> {
    if raw.is_empty() {
        return Err(HostError::Missing);
    }
    if raw.len() > 260 || raw.starts_with('[') || raw.contains('@') {
        return Err(HostError::Invalid);
    }
    let host = match raw.rsplit_once(':') {
        Some((host, port)) => {
            if port.is_empty() || port.len() > 5 || !port.bytes().all(|c| c.is_ascii_digit()) {
                return Err(HostError::Invalid);
            }
            host
        }
        None => raw,
    };
    let host = host.strip_suffix('.').unwrap_or(host);
    let host = host.to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 || !host.split('.').all(is_valid_label) {
        return Err(HostError::Invalid);
    }
    Ok(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versioned(hash: char, status: RouteStatus, version: Option<u64>) -> RouteEntry {
        RouteEntry {
            hostname: "a.renox.app".into(),
            tenant_id: "t_a".into(),
            deployment_hash: hash.to_string().repeat(64),
            status,
            updated_at: 0,
            display_name: None,
            version,
        }
    }

    /// #97: an upsert that is not newer than the stored entry is ignored,
    /// so a reordered delta cannot undo a switch.
    #[test]
    fn older_versions_are_ignored() {
        let t = RouteTable::new();
        assert!(
            t.upsert(versioned('a', RouteStatus::Active, Some(5)))
                .unwrap()
        );
        assert!(
            !t.upsert(versioned('a', RouteStatus::Draining, Some(4)))
                .unwrap()
        );
        assert!(
            !t.upsert(versioned('a', RouteStatus::Draining, Some(5)))
                .unwrap()
        );
        assert_eq!(t.lookup("a.renox.app").unwrap().version, Some(5));
        assert!(
            t.upsert(versioned('a', RouteStatus::Draining, Some(6)))
                .unwrap()
        );
        assert!(t.lookup("a.renox.app").is_none());
        // Without versions (a local file), the last write wins as before.
        assert!(t.upsert(versioned('b', RouteStatus::Active, None)).unwrap());
        assert!(
            t.upsert(versioned('b', RouteStatus::Draining, None))
                .unwrap()
        );
    }

    #[test]
    fn replace_swaps_the_whole_table_or_nothing() {
        let t = RouteTable::new();
        t.replace(vec![versioned('a', RouteStatus::Active, Some(1))])
            .unwrap();
        let two_active = vec![
            versioned('a', RouteStatus::Active, Some(2)),
            versioned('b', RouteStatus::Active, Some(3)),
        ];
        assert!(t.replace(two_active).is_err());
        assert_eq!(t.lookup("a.renox.app").unwrap().version, Some(1));
        // A local file never carries `version`.
        assert!(t.reload_from_json(r#"{"version":0,"entries":[{"hostname":"a.renox.app","tenant_id":"t_a","deployment_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","status":"active","updated_at":1,"version":3}]}"#).is_err());
    }

    #[test]
    fn host_parsing() {
        assert_eq!(
            parse_host("Hello.Renox.App:8443").unwrap(),
            "hello.renox.app"
        );
        assert_eq!(parse_host("hello.renox.app.").unwrap(), "hello.renox.app");
        assert_eq!(parse_host("localhost").unwrap(), "localhost");
        assert_eq!(parse_host(""), Err(HostError::Missing));
        for bad in [
            "[::1]:80",
            "a b.com",
            "a_b.com",
            "x.com:",
            "x.com:99999a",
            "user@x.com",
            "-a.com",
            "a..com",
            "x.com:80:80",
            "é.com",
        ] {
            assert_eq!(parse_host(bad), Err(HostError::Invalid), "{bad}");
        }
    }

    #[test]
    fn file_validation_is_all_or_nothing() {
        let hash = "a".repeat(64);
        let good = format!(
            r#"{{"version":0,"entries":[{{"hostname":"a.test","tenant_id":"t_a","deployment_hash":"{hash}","status":"active","updated_at":1}}]}}"#
        );
        let table = RouteTable::from_json(&good).unwrap();
        assert!(table.lookup("a.test").is_some());

        let two_active = format!(
            r#"{{"version":0,"entries":[
              {{"hostname":"b.test","tenant_id":"t_b","deployment_hash":"{hash}","status":"active","updated_at":1}},
              {{"hostname":"b.test","tenant_id":"t_b","deployment_hash":"{b}","status":"active","updated_at":1}}]}}"#,
            b = "b".repeat(64)
        );
        assert!(matches!(
            table.reload_from_json(&two_active),
            Err(RouteTableError::DuplicateActive(_))
        ));
        let unknown_key = good.replace("\"updated_at\":1", "\"updated_at\":1,\"x\":1");
        assert!(table.reload_from_json(&unknown_key).is_err());
        // The previous table stays in use.
        assert!(table.lookup("a.test").is_some());
        assert!(table.lookup("b.test").is_none());
    }
}
