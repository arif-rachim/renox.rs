//! The activation probe (#96, `docs/contracts/deploy-api.md` section 6,
//! "Probe"): the new deployment's cell is created and sent one `GET` before
//! any route points at it. The request goes through the cell manager
//! directly, with `x-renox-probe: 1`, the tenant's normal limits, and the
//! probe's timeout; it is metered like any request.
//!
//! It passes for any status below 500: a function app's only `GET` route
//! may answer 401 or 404 to an anonymous request. A 5xx (including the
//! platform's `RENOX_CPU_LIMIT`, `RENOX_OOM`, `RENOX_DEADLINE` answers), a
//! timeout, or a cell that could not be created fails it.

use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

use axum::body::Body;
use http::Request;
use renox_gateway::{CellDispatcher, RequestCtx};

use crate::cell::CellKey;
use crate::manager::CellManager;

/// Path requested when the manifest has no probe route (`probe: null`): no
/// route matches it, so only cell creation is checked (a 404 from route
/// matching runs no tenant code and writes no meter record).
pub const CREATE_ONLY_PATH: &str = "/__renox/prepare";

/// Why the probe failed: `load` (no cell) or `probe` (status or timeout).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeFailure {
    pub stage: &'static str,
    pub reason: String,
    pub http_status: Option<u16>,
}

/// The pass rule of section 6.
pub fn passes(status: u16) -> bool {
    status < 500
}

/// Creates the cell of `key` and sends the probe. `path: None` only creates
/// the cell. `request_id` names the probe in the meter record and the logs.
pub async fn probe(
    manager: &CellManager,
    key: &CellKey,
    path: Option<&str>,
    timeout: Duration,
    request_id: &str,
) -> Result<(), ProbeFailure> {
    let target = path.unwrap_or(CREATE_ONLY_PATH);
    let req = Request::get(target)
        .header("x-renox-probe", "1")
        .header("x-renox-request-id", request_id)
        .body(Body::empty())
        .map_err(|e| ProbeFailure {
            stage: "probe",
            reason: format!("probe request: {e}"),
            http_status: None,
        })?;
    let ctx = RequestCtx {
        tenant_id: key.tenant_id.clone(),
        deployment_hash: key.deployment_hash.clone(),
        request_id: request_id.to_string(),
        deadline: Instant::now() + timeout,
        client_ip: IpAddr::V4(Ipv4Addr::LOCALHOST),
        csp_nonce: String::new(),
    };
    let answer = tokio::time::timeout(timeout, manager.dispatch(ctx, req)).await;
    let status = match answer {
        Ok(res) => res.status().as_u16(),
        Err(_) => {
            return Err(ProbeFailure {
                stage: "probe",
                reason: format!("the probe did not answer within {} ms", timeout.as_millis()),
                http_status: None,
            });
        }
    };
    // The cell is created by the dispatch; if it is not there, the
    // deployment did not load (the node log has the cause).
    if !manager.cells().contains(key) {
        return Err(ProbeFailure {
            stage: "load",
            reason: "the cell could not be created (modules, templates, or secrets)".into(),
            http_status: None,
        });
    }
    if path.is_some() && !passes(status) {
        return Err(ProbeFailure {
            stage: "probe",
            reason: format!("GET {target} answered {status}"),
            http_status: Some(status),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn below_500_passes() {
        for s in [200, 204, 301, 401, 404, 499] {
            assert!(super::passes(s), "{s}");
        }
        for s in [500, 502, 503, 504] {
            assert!(!super::passes(s), "{s}");
        }
    }
}
