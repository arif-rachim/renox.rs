//! Per-route rate-limit buckets (#47; `docs/contracts/artifact.md` section
//! 3, `security.ratelimit[]`; `docs/04-isolation-security.md`, "Rate
//! limiting"). The gateway does not match routes (gate F1 note on #47), so
//! the buckets are enforced here, after the runtime's router has found the
//! route, on top of the gateway's per-IP limit. A bucket names a
//! `(method, path)` some route answers (V16); `HEAD` uses the `GET` bucket.
//! Key `ip` only (`user` is F4). Over the bucket: 429 with `Retry-After`,
//! no tenant code, no meter record, as for the gateway's own limit.

use std::net::IpAddr;

use renox_gateway::security::RateBucket;
use renox_gateway::{RateDecision, RateLimitConfig, RateLimiter};
use renox_runtime::manifest::RouteDef;
use renox_runtime::router::{RouteMatch, Router};

/// Clients tracked per bucket before idle ones are dropped.
const MAX_TRACKED: usize = 100_000;

struct Bucket {
    method: String,
    /// The route pattern (`/login`, `/products/:id`).
    path: String,
    limiter: RateLimiter,
}

/// The buckets of one deployment.
pub struct RouteBuckets {
    router: Router,
    patterns: Vec<String>,
    buckets: Vec<Bucket>,
}

impl std::fmt::Debug for RouteBuckets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RouteBuckets")
            .field("buckets", &self.buckets.len())
            .finish_non_exhaustive()
    }
}

impl RouteBuckets {
    /// `None` when the deployment declares no bucket.
    pub fn new(routes: &[RouteDef], declared: &[RateBucket]) -> Option<RouteBuckets> {
        if declared.is_empty() {
            return None;
        }
        let router = Router::new(routes).ok()?;
        let buckets = declared
            .iter()
            .filter(|b| b.key == "ip")
            .map(|b| Bucket {
                method: b.method.clone(),
                path: b.path.clone(),
                limiter: RateLimiter::new(RateLimitConfig {
                    requests_per_second: f64::from(b.requests) / f64::from(b.window_s.max(1)),
                    burst: b.requests,
                    max_tracked_clients: MAX_TRACKED,
                }),
            })
            .collect();
        Some(RouteBuckets {
            router,
            patterns: routes.iter().map(|r| r.path.clone()).collect(),
            buckets,
        })
    }

    /// `Some(retry_after_secs)` when the request's route bucket for this
    /// client is empty.
    pub fn check(&self, method: &str, path: &str, ip: IpAddr) -> Option<u64> {
        let RouteMatch::Found { route, .. } = self.router.find(method, path) else {
            return None;
        };
        let pattern = &self.patterns[route];
        let method = if method == "HEAD" { "GET" } else { method };
        for b in &self.buckets {
            if b.method == method
                && b.path == *pattern
                && let RateDecision::Limited { retry_after_secs } = b.limiter.check(ip)
            {
                return Some(retry_after_secs);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `docs/23-failure-modes.md`, "Request flood from one IP", per route:
    /// a login bucket of 3 per minute stops the fourth request from one
    /// address, not another address, and not another route.
    #[test]
    fn per_route_bucket() {
        let routes: Vec<RouteDef> = serde_json::from_value(serde_json::json!([
            { "kind": "function", "method": "POST", "path": "/api/login", "module": "functions/api/login", "export": "POST" },
            { "kind": "page", "path": "/products/:id", "module": "pages/p", "load": true, "actions": ["add"], "template": "pages/p" }
        ]))
        .unwrap();
        let declared: Vec<RateBucket> = serde_json::from_value(serde_json::json!([
            { "method": "POST", "path": "/api/login", "requests": 3, "window_s": 60, "key": "ip" },
            { "method": "GET", "path": "/products/:id", "requests": 1, "window_s": 60, "key": "ip" }
        ]))
        .unwrap();
        let b = RouteBuckets::new(&routes, &declared).unwrap();
        let a: IpAddr = "192.0.2.1".parse().unwrap();
        let other: IpAddr = "192.0.2.2".parse().unwrap();
        for _ in 0..3 {
            assert_eq!(b.check("POST", "/api/login", a), None);
        }
        let retry = b.check("POST", "/api/login", a).expect("limited");
        assert!((1..=20).contains(&retry), "{retry}");
        assert_eq!(b.check("POST", "/api/login", other), None);
        // Page GET bucket keyed by the pattern; HEAD shares it; POST does not.
        assert_eq!(b.check("GET", "/products/1", a), None);
        assert!(b.check("HEAD", "/products/2", a).is_some());
        assert_eq!(b.check("POST", "/products/1", a), None);
        assert_eq!(b.check("GET", "/nowhere", a), None);
        assert!(RouteBuckets::new(&routes, &[]).is_none());
    }
}
