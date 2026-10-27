//! The tier table (`docs/04-isolation-security.md`, "Per-tenant limits";
//! `docs/contracts/ops.md` section 10). The worker config can override any
//! number; the manifest can only lower the runtime limits further.

use std::collections::BTreeMap;

use renox_data::{FREE_QUOTA_BYTES, PAID_QUOTA_BYTES};
use renox_runtime::limits::Limits;
use serde::Deserialize;

/// The limits of one tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tier {
    /// CPU time per request.
    pub cpu_ms: u64,
    /// Wall clock per request.
    pub wall_ms: u64,
    /// V8 heap per isolate.
    pub heap_mb: u64,
    /// In-flight requests per deployment.
    pub concurrency: u32,
    /// Database file size quota.
    pub db_quota_bytes: u64,
    /// Outbound `fetch` bytes per request (sent + received).
    pub egress_bytes: u64,
    /// Log lines per tenant per minute.
    pub log_lines_per_min: u64,
}

impl Tier {
    pub const FREE: Tier = Tier {
        cpu_ms: Limits::FREE.cpu_ms,
        wall_ms: Limits::FREE.wall_ms,
        heap_mb: Limits::FREE.heap_bytes / (1024 * 1024),
        concurrency: Limits::FREE.concurrency,
        db_quota_bytes: FREE_QUOTA_BYTES,
        egress_bytes: Limits::FREE.egress_bytes,
        log_lines_per_min: Limits::FREE.log_lines_per_min,
    };

    pub const PAID: Tier = Tier {
        cpu_ms: Limits::PAID.cpu_ms,
        wall_ms: Limits::PAID.wall_ms,
        heap_mb: Limits::PAID.heap_bytes / (1024 * 1024),
        concurrency: Limits::PAID.concurrency,
        db_quota_bytes: PAID_QUOTA_BYTES,
        egress_bytes: Limits::PAID.egress_bytes,
        log_lines_per_min: Limits::PAID.log_lines_per_min,
    };

    /// The runtime limits of this tier. Module evaluation keeps the
    /// runtime's per-tier budget (`ops.md` section 10, last row).
    pub fn runtime_limits(&self, base: Limits) -> Limits {
        Limits {
            cpu_ms: self.cpu_ms,
            wall_ms: self.wall_ms,
            heap_bytes: self.heap_mb * 1024 * 1024,
            concurrency: self.concurrency,
            egress_bytes: self.egress_bytes,
            log_lines_per_min: self.log_lines_per_min,
            ..base
        }
    }
}

/// Overrides of one tier in the worker config: any subset of the fields.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TierOverride {
    pub cpu_ms: Option<u64>,
    pub wall_ms: Option<u64>,
    pub heap_mb: Option<u64>,
    pub concurrency: Option<u32>,
    pub db_quota_bytes: Option<u64>,
    pub egress_bytes: Option<u64>,
    pub log_lines_per_min: Option<u64>,
}

/// Tier names, with their tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TierName {
    Free,
    Paid,
}

/// The tier table after config overrides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tiers {
    pub free: Tier,
    pub paid: Tier,
}

impl Default for Tiers {
    fn default() -> Self {
        Tiers {
            free: Tier::FREE,
            paid: Tier::PAID,
        }
    }
}

impl Tiers {
    pub fn with_overrides(overrides: &BTreeMap<TierName, TierOverride>) -> Tiers {
        let mut t = Tiers::default();
        for (name, o) in overrides {
            let tier = match name {
                TierName::Free => &mut t.free,
                TierName::Paid => &mut t.paid,
            };
            let set = |dst: &mut u64, v: Option<u64>| {
                if let Some(v) = v {
                    *dst = v;
                }
            };
            set(&mut tier.cpu_ms, o.cpu_ms);
            set(&mut tier.wall_ms, o.wall_ms);
            set(&mut tier.heap_mb, o.heap_mb);
            set(&mut tier.db_quota_bytes, o.db_quota_bytes);
            set(&mut tier.egress_bytes, o.egress_bytes);
            set(&mut tier.log_lines_per_min, o.log_lines_per_min);
            if let Some(c) = o.concurrency {
                tier.concurrency = c;
            }
        }
        t
    }

    pub fn get(&self, name: TierName) -> &Tier {
        match name {
            TierName::Free => &self.free,
            TierName::Paid => &self.paid,
        }
    }

    /// The longest wall-clock limit: the gateway's deadline, which the
    /// runtime then caps per tier.
    pub fn max_wall_ms(&self) -> u64 {
        self.free.wall_ms.max(self.paid.wall_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_docs() {
        let t = Tiers::default();
        assert_eq!((t.free.cpu_ms, t.paid.cpu_ms), (50, 500));
        assert_eq!((t.free.wall_ms, t.paid.wall_ms), (30_000, 60_000));
        assert_eq!((t.free.heap_mb, t.paid.heap_mb), (128, 512));
        assert_eq!((t.free.concurrency, t.paid.concurrency), (50, 500));
        assert_eq!(t.free.db_quota_bytes, 100 * 1024 * 1024);
        assert_eq!(t.paid.db_quota_bytes, 10 * 1024 * 1024 * 1024);
    }

    #[test]
    fn overrides_replace_single_fields() {
        let o: BTreeMap<TierName, TierOverride> = [(
            TierName::Free,
            TierOverride {
                cpu_ms: Some(20),
                ..Default::default()
            },
        )]
        .into();
        let t = Tiers::with_overrides(&o);
        assert_eq!(t.free.cpu_ms, 20);
        assert_eq!(t.free.wall_ms, 30_000);
        assert_eq!(t.paid, Tier::PAID);
    }
}
