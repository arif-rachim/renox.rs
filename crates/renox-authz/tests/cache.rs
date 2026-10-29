//! The decision cache: hits, TTL, invalidation per principal, keys that
//! include what a decision depends on.

mod common;

use std::time::Duration;

use common::*;
use renox_authz::{CacheKey, DecisionCache};
use serde_json::json;

#[test]
fn hits_ttl_and_invalidation() {
    let e = engine();
    let cache = DecisionCache::new(1000);
    let inv = invoice("inv_1", 10, "o_1");
    let ask = |cache: &DecisionCache,
               p: &renox_authz::Principal,
               r: &serde_json::Value,
               ttl: Duration| {
        cache.get_or_compute(CacheKey::new(p, "invoice.read", Some(r), None), ttl, || {
            e.check(p, "invoice.read", Some(r), Some("billing"), None, &now())
        })
    };
    assert!(ask(&cache, &alice(), &inv, Duration::from_secs(60)).allow);
    assert!(ask(&cache, &alice(), &inv, Duration::from_secs(60)).allow);
    let s = cache.stats();
    assert_eq!((s.hits, s.misses, s.entries), (1, 1, 1));
    assert!((s.hit_rate() - 0.5).abs() < 1e-9);
    // A changed attribute of the resource is another key.
    ask(
        &cache,
        &alice(),
        &invoice("inv_1", 10, "o_2"),
        Duration::from_secs(60),
    );
    // Another principal state (a role revoked) is another key too.
    let mut fewer = alice();
    fewer.roles.clear();
    assert!(!ask(&cache, &fewer, &inv, Duration::from_secs(60)).allow);
    assert_eq!(cache.stats().misses, 3);
    cache.invalidate("u_alice");
    assert_eq!(cache.stats().entries, 0);
    // TTL zero: never served from the cache.
    ask(&cache, &alice(), &inv, Duration::ZERO);
    ask(&cache, &alice(), &inv, Duration::ZERO);
    assert_eq!(cache.stats().hits, 1);
    let _ = json!(null);
}

#[test]
fn a_full_cache_is_emptied_not_grown() {
    let cache = DecisionCache::new(2);
    let e = engine();
    for i in 0..5 {
        let inv = invoice(&format!("inv_{i}"), 1, "o_1");
        cache.get_or_compute(
            CacheKey::new(&alice(), "invoice.read", Some(&inv), None),
            Duration::from_secs(60),
            || {
                e.check(
                    &alice(),
                    "invoice.read",
                    Some(&inv),
                    Some("billing"),
                    None,
                    &now(),
                )
            },
        );
        assert!(cache.stats().entries <= 2);
    }
}
