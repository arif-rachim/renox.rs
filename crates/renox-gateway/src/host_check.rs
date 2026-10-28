//! SNI / `Host` consistency (`docs/24-threat-model.md` section C, "Host/SNI
//! confusion").
//!
//! On a TLS connection the certificate was chosen by the SNI name, but
//! routing uses `Host` (HTTP/1.1) or `:authority` (HTTP/2). A client can
//! complete the handshake for one tenant's hostname and then ask for
//! another's. Two hostnames of the **same** tenant may share a connection
//! (HTTP/2 connection coalescing under one certificate); a request for a
//! hostname that resolves to a **different** tenant, or to none, is answered
//! with `421 Misdirected Request` and `RENOX_HOST_MISMATCH`, which browsers
//! retry on a new connection (RFC 9110 section 15.5.20).

use crate::route_table::{RouteTable, parse_host};

/// Request extension set on requests that arrived on a TLS connection with
/// an SNI name: the name as the client sent it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TlsSni(pub String);

/// Code and fixed message of the 421 response (`docs/contracts/errors.md`
/// row to be added by the F2 contract issue).
pub const HOST_MISMATCH_CODE: &str = "RENOX_HOST_MISMATCH";
pub const HOST_MISMATCH_MESSAGE: &str = "The request was sent on a connection for another host.";

/// Whether a request for `host` (already normalised by [`parse_host`]) may
/// be served on a connection whose TLS SNI was `sni`. `None` (plain HTTP,
/// or TLS without SNI, which the certificate resolver refuses) is always
/// consistent.
pub fn consistent(routes: &RouteTable, sni: Option<&str>, host: &str) -> bool {
    let Some(sni) = sni else { return true };
    let Ok(sni) = parse_host(sni) else {
        return false;
    };
    if sni == host {
        return true;
    }
    match (routes.lookup(&sni), routes.lookup(host)) {
        (Some(a), Some(b)) => a.tenant_id == b.tenant_id,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route_table::{RouteEntry, RouteStatus};

    fn table() -> RouteTable {
        let t = RouteTable::new();
        for (host, tenant, hash) in [
            ("a.test", "t_a", "a"),
            ("www.a.test", "t_a", "a"),
            ("b.test", "t_b", "b"),
        ] {
            t.upsert(RouteEntry {
                hostname: host.into(),
                tenant_id: tenant.into(),
                deployment_hash: hash.repeat(64),
                status: RouteStatus::Active,
                updated_at: 0,
            })
            .unwrap();
        }
        t
    }

    #[test]
    fn sni_and_host_must_resolve_to_the_same_tenant() {
        let t = table();
        assert!(consistent(&t, None, "b.test"));
        assert!(consistent(&t, Some("a.test"), "a.test"));
        assert!(consistent(&t, Some("A.TEST."), "a.test"));
        assert!(consistent(&t, Some("a.test"), "www.a.test"));
        assert!(!consistent(&t, Some("a.test"), "b.test"));
        assert!(!consistent(&t, Some("unknown.test"), "b.test"));
        assert!(!consistent(&t, Some("not a host"), "b.test"));
    }
}
