//! Per-request and per-isolate limits (`docs/contracts/ops.md` section 10,
//! `docs/04-isolation-security.md`, "Per-tenant limits").

use crate::manifest::LimitOverrides;

/// The limits of one deployment. The cell passes the tier's numbers; the
/// manifest may only lower them (`artifact.md` section 3, "Limits overrides").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// CPU time per request, milliseconds.
    pub cpu_ms: u64,
    /// Wall clock per request, milliseconds. The cell's `RequestCtx.deadline`
    /// is `min(now + wall_ms, gateway deadline)`.
    pub wall_ms: u64,
    /// V8 heap limit of the isolate, bytes.
    pub heap_bytes: u64,
    /// In-flight requests per deployment.
    pub concurrency: u32,
    /// Outbound `fetch` bytes per request, sent + received (`ops.md` section 2).
    pub egress_bytes: u64,
}

impl Limits {
    /// Free tier (`ops.md` section 10).
    pub const FREE: Limits = Limits {
        cpu_ms: 50,
        wall_ms: 30_000,
        heap_bytes: 128 * 1024 * 1024,
        concurrency: 50,
        egress_bytes: 10 * 1024 * 1024,
    };

    /// Paid tier (`ops.md` section 10).
    pub const PAID: Limits = Limits {
        cpu_ms: 500,
        wall_ms: 60_000,
        heap_bytes: 512 * 1024 * 1024,
        concurrency: 500,
        egress_bytes: 100 * 1024 * 1024,
    };

    /// Apply the manifest's overrides: `min(override, tier)` per field, so
    /// an app can lower a limit but never raise it.
    pub fn with_overrides(self, o: Option<&LimitOverrides>) -> Limits {
        let Some(o) = o else { return self };
        Limits {
            cpu_ms: o.cpu_ms.map_or(self.cpu_ms, |v| v.min(self.cpu_ms)),
            wall_ms: o.wall_ms.map_or(self.wall_ms, |v| v.min(self.wall_ms)),
            heap_bytes: o
                .memory_mb
                .map_or(self.heap_bytes, |v| (v * 1024 * 1024).min(self.heap_bytes)),
            concurrency: o.concurrency.map_or(self.concurrency, |v| {
                (v.min(u64::from(self.concurrency))) as u32
            }),
            egress_bytes: self.egress_bytes,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Limits::FREE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overrides_only_lower() {
        let o = LimitOverrides {
            cpu_ms: Some(10),
            wall_ms: Some(120_000),
            memory_mb: Some(64),
            concurrency: Some(1000),
        };
        let l = Limits::FREE.with_overrides(Some(&o));
        assert_eq!(l.cpu_ms, 10);
        assert_eq!(l.wall_ms, 30_000);
        assert_eq!(l.heap_bytes, 64 * 1024 * 1024);
        assert_eq!(l.concurrency, 50);
    }
}
