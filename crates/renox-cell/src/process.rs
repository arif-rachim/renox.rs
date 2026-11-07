//! Where a tenant's cells run (#254). The types are platform-neutral because
//! route entries carry `process` on every host; the supervisor that acts on
//! them (`crate::supervisor`) is Unix-only (#442, #530).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Where a tenant's cells run (route entry `process`, `deploy-api.md` 0.3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessKind {
    #[default]
    Shared,
    Own,
}

impl ProcessKind {
    pub fn is_shared(&self) -> bool {
        *self == ProcessKind::Shared
    }
}

/// The placement of a tenant: the route entries in controlled mode
/// (`RouteState`), `[process] own_tenants` in local mode.
pub trait ProcessLookup: Send + Sync + 'static {
    fn process(&self, tenant_id: &str) -> ProcessKind;
}

/// Local mode: `[process] own_tenants`.
pub struct StaticProcesses(pub HashSet<String>);

impl ProcessLookup for StaticProcesses {
    fn process(&self, tenant_id: &str) -> ProcessKind {
        if self.0.contains(tenant_id) {
            ProcessKind::Own
        } else {
            ProcessKind::Shared
        }
    }
}
