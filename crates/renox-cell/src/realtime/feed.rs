//! The change feed (#305; `docs/contracts/ops.md` 1.5.0 section 18,
//! "Change feed"): `[realtime.feeds] "shop__orders" = "orders:{org_id}"`.
//!
//! The tenant file's commit-time row capture ([`TenantDb::on_rows_changed`])
//! hands the cell every committed change of a fed table; the cell fills the
//! topic's placeholders from the row and publishes `{ table, rowid, op }`
//! through the deployment's hub. Nothing is published for a rolled-back
//! transaction, a failed statement or a rolled-back savepoint. Delivery goes
//! only to connections that passed the subscribe check for the topic (the
//! hub's subscriptions), so the topic's policy is the whole filter, and the
//! message counts as `realtime_messages` of the receiving connections only.
//!
//! A row whose placeholder column is `NULL` is not published; a transaction
//! that changed more than [`renox_data::FEED_MAX_ROWS`] fed rows publishes
//! nothing and logs one line (`ops.md` section 18).
//!
//! [`TenantDb::on_rows_changed`]: renox_data::TenantDb::on_rows_changed

use std::sync::{Arc, Weak};

use renox_data::{ChangeOp, RowChange, Value};
use renox_realtime::{Hub, Payload};
use renox_runtime::ops::db::DbHandle;

/// One `[realtime.feeds]` entry: a table and its topic pattern.
#[derive(Debug, Clone, PartialEq)]
pub struct FeedDef {
    pub table: String,
    parts: Vec<Part>,
}

#[derive(Debug, Clone, PartialEq)]
enum Part {
    Text(String),
    Column(String),
}

impl FeedDef {
    /// `orders:{org_id}` for `table`; `None` when a `{` is not closed.
    pub fn parse(table: &str, pattern: &str) -> Option<FeedDef> {
        let mut parts = Vec::new();
        let mut rest = pattern;
        while let Some(open) = rest.find('{') {
            if open > 0 {
                parts.push(Part::Text(rest[..open].to_string()));
            }
            let close = rest[open..].find('}')? + open;
            parts.push(Part::Column(rest[open + 1..close].to_string()));
            rest = &rest[close + 1..];
        }
        if !rest.is_empty() {
            parts.push(Part::Text(rest.to_string()));
        }
        Some(FeedDef {
            table: table.to_string(),
            parts,
        })
    }

    /// The columns the pattern names, in order.
    pub fn columns(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in &self.parts {
            if let Part::Column(c) = p
                && !out.contains(c)
            {
                out.push(c.clone());
            }
        }
        out
    }

    /// The topic for a changed row; `None` when a placeholder is `NULL`.
    pub fn topic(&self, columns: &[(String, Value)]) -> Option<String> {
        let mut out = String::new();
        for p in &self.parts {
            match p {
                Part::Text(t) => out.push_str(t),
                Part::Column(c) => match columns.iter().find(|(n, _)| n == c).map(|(_, v)| v) {
                    Some(Value::Text(s)) => out.push_str(s),
                    Some(Value::Integer(i)) => out.push_str(&i.to_string()),
                    Some(Value::Real(f)) => out.push_str(&f.to_string()),
                    Some(Value::Blob(_)) | Some(Value::Null) | None => return None,
                },
            }
        }
        Some(out)
    }
}

/// The feeds of the app (`realtime.feeds`) and of each installed module
/// (`modules[].realtime.feeds`) in a manifest. V26 already checked that each
/// table is under its owner's prefix and that each pattern is a topic.
pub fn feeds(manifest: &serde_json::Value) -> Vec<FeedDef> {
    let mut blocks = vec![manifest.get("realtime")];
    if let Some(modules) = manifest.get("modules").and_then(|m| m.as_array()) {
        blocks.extend(modules.iter().map(|m| m.get("realtime")));
    }
    blocks
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("feeds").and_then(|f| f.as_object()))
        .flat_map(|f| f.iter())
        .filter_map(|(table, pattern)| FeedDef::parse(table, pattern.as_str()?))
        .collect()
}

/// The JSON message of one change: `{ "table", "rowid", "op" }`.
pub fn message(change: &RowChange) -> String {
    serde_json::json!({
        "table": change.table,
        "rowid": change.rowid,
        "op": change.op.as_str(),
    })
    .to_string()
}

/// Publish one transaction's committed changes; returns the messages
/// published (to topics with at least one subscriber or not).
pub fn publish(hub: &Hub, defs: &[FeedDef], changes: Vec<RowChange>) -> usize {
    if changes.iter().any(|c| c.op == ChangeOp::Many) {
        let tables: Vec<&str> = changes.iter().map(|c| c.table.as_str()).collect();
        tracing::warn!(
            tables = ?tables,
            max_rows = renox_data::FEED_MAX_ROWS,
            "change feed: a transaction changed more fed rows than the feed carries; nothing was published"
        );
        return 0;
    }
    let mut published = 0;
    for change in &changes {
        let Some(def) = defs.iter().find(|d| d.table == change.table) else {
            continue;
        };
        let Some(topic) = def.topic(&change.columns) else {
            continue;
        };
        if hub.publish(&topic, Payload::text(message(change))).is_ok() {
            published += 1;
        }
    }
    published
}

/// Subscribe the deployment's hub to the tenant file's committed changes of
/// the fed tables. The hook holds the hub weakly: after the cell is gone it
/// does nothing, and the tenant's next cell installs its own.
pub async fn attach(db: &DbHandle, hub: &Arc<Hub>, defs: Vec<FeedDef>) -> Result<(), String> {
    let tables: Vec<(String, Vec<String>)> = defs
        .iter()
        .map(|d| (d.table.clone(), d.columns()))
        .collect();
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let defs = Arc::new(defs);
    let deliver: renox_data::RowsChanged = Arc::new(move |changes| {
        if let Some(hub) = weak.upgrade() {
            publish(&hub, &defs, changes);
        }
    });
    db.call(move |db| db.on_rows_changed(&tables, deliver))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pattern_fills_from_the_row_and_a_null_owner_is_not_published() {
        let d = FeedDef::parse("shop__orders", "orders:{org_id}").unwrap();
        assert_eq!(d.columns(), vec!["org_id".to_string()]);
        let row = |v: Value| vec![("org_id".to_string(), v)];
        assert_eq!(
            d.topic(&row(Value::Text("o1".into()))).as_deref(),
            Some("orders:o1")
        );
        assert_eq!(
            d.topic(&row(Value::Integer(7))).as_deref(),
            Some("orders:7")
        );
        assert_eq!(d.topic(&row(Value::Null)), None);
        let fixed = FeedDef::parse("shop__orders", "orders").unwrap();
        assert!(fixed.columns().is_empty());
        assert_eq!(fixed.topic(&[]).as_deref(), Some("orders"));
        assert!(FeedDef::parse("t", "a:{b").is_none());
    }

    #[test]
    fn the_app_and_module_feeds_are_read_from_the_manifest() {
        let m = serde_json::json!({
            "realtime": { "feeds": { "app__orders": "orders:{org_id}" } },
            "modules": [{ "name": "chat", "realtime": { "feeds": { "chat__messages": "room:{room_id}" } } }, { "name": "auth" }]
        });
        let tables: Vec<String> = feeds(&m).into_iter().map(|d| d.table).collect();
        assert_eq!(tables, vec!["app__orders", "chat__messages"]);
    }
}
