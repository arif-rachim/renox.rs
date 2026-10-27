//! Per-client-IP token bucket (`docs/04-isolation-security.md`, "Rate
//! limiting"; `docs/23-failure-modes.md`, "Request flood from one IP").
//!
//! State is in memory only, no persistence. IPv6 clients are keyed by their
//! /64 prefix, since one subscriber usually holds a whole /64 and could
//! otherwise rotate addresses to get a fresh bucket per request.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Rate limit configuration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateLimitConfig {
    /// Sustained requests per second per client IP.
    pub requests_per_second: f64,
    /// Bucket size: requests a client may send at once after being idle.
    pub burst: u32,
    /// Upper bound on tracked clients. When it is reached, buckets that have
    /// refilled completely are dropped (they carry no state worth keeping).
    pub max_tracked_clients: usize,
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            requests_per_second: 100.0,
            burst: 200,
            max_tracked_clients: 100_000,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

/// Outcome of [`RateLimiter::check`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateDecision {
    Allow,
    /// Rejected; the client may retry after this many whole seconds (≥ 1).
    Limited {
        retry_after_secs: u64,
    },
}

/// Token bucket per client IP.
#[derive(Debug)]
pub struct RateLimiter {
    config: RateLimitConfig,
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn config(&self) -> &RateLimitConfig {
        &self.config
    }

    /// Takes one token for `ip` at the current time.
    pub fn check(&self, ip: IpAddr) -> RateDecision {
        self.check_at(ip, Instant::now())
    }

    /// Takes one token for `ip` at time `now`.
    pub fn check_at(&self, ip: IpAddr, now: Instant) -> RateDecision {
        let rate = self.config.requests_per_second.max(f64::MIN_POSITIVE);
        let burst = f64::from(self.config.burst.max(1));
        let key = bucket_key(ip);
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        if buckets.len() >= self.config.max_tracked_clients && !buckets.contains_key(&key) {
            buckets.retain(|_, b| {
                b.tokens + now.saturating_duration_since(b.last).as_secs_f64() * rate < burst
            });
        }
        let bucket = buckets.entry(key).or_insert(Bucket {
            tokens: burst,
            last: now,
        });
        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate).min(burst);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            RateDecision::Allow
        } else {
            let wait = Duration::from_secs_f64((1.0 - bucket.tokens) / rate);
            let secs = wait.as_secs() + u64::from(wait.subsec_nanos() > 0);
            RateDecision::Limited {
                retry_after_secs: secs.max(1),
            }
        }
    }
}

/// IPv4 addresses (and IPv4-mapped IPv6) as is; other IPv6 by /64.
pub(crate) fn bucket_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limiter(rps: f64, burst: u32) -> RateLimiter {
        RateLimiter::new(RateLimitConfig {
            requests_per_second: rps,
            burst,
            max_tracked_clients: 4,
        })
    }

    #[test]
    fn burst_then_refill() {
        let l = limiter(10.0, 3);
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..3 {
            assert_eq!(l.check_at(ip, t0), RateDecision::Allow);
        }
        assert_eq!(
            l.check_at(ip, t0),
            RateDecision::Limited {
                retry_after_secs: 1
            }
        );
        // 10 rps: one token after 100 ms.
        assert_eq!(
            l.check_at(ip, t0 + Duration::from_millis(110)),
            RateDecision::Allow
        );
        // Another client is unaffected.
        let other: IpAddr = "192.0.2.2".parse().unwrap();
        assert_eq!(l.check_at(other, t0), RateDecision::Allow);
    }

    #[test]
    fn retry_after_rounds_up() {
        let l = limiter(0.25, 1);
        let ip: IpAddr = "192.0.2.1".parse().unwrap();
        let t0 = Instant::now();
        assert_eq!(l.check_at(ip, t0), RateDecision::Allow);
        assert_eq!(
            l.check_at(ip, t0),
            RateDecision::Limited {
                retry_after_secs: 4
            }
        );
    }

    #[test]
    fn ipv6_shares_a_bucket_per_64() {
        let l = limiter(1.0, 1);
        let t0 = Instant::now();
        let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2::ffff".parse().unwrap();
        assert_eq!(l.check_at(a, t0), RateDecision::Allow);
        assert!(matches!(l.check_at(b, t0), RateDecision::Limited { .. }));
    }

    #[test]
    fn table_is_bounded() {
        let l = limiter(1000.0, 1);
        let t0 = Instant::now();
        for i in 0..100u8 {
            let ip = IpAddr::from([198, 51, 100, i]);
            l.check_at(ip, t0 + Duration::from_secs(u64::from(i)));
        }
        assert!(l.buckets.lock().unwrap().len() <= 4);
    }
}
