//! The decision cache (`docs/11-authorization.md`, "Performance"): one
//! per cell, keyed by everything a decision depends on, with a TTL from the
//! caller and invalidation per principal (a role change, a logout).

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::{Decision, Principal};

/// What a cached decision depends on: the principal (id, kind, roles in
/// effect, attributes), the action, the resource (type, id, and attribute
/// values: a changed amount is another question), and the caller's context.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CacheKey {
    principal_id: String,
    principal: u64,
    action: String,
    resource: Option<(String, String, u64)>,
    context: u64,
}

fn hash_json(v: &impl serde::Serialize) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(v).unwrap_or_default().hash(&mut h);
    h.finish()
}

impl CacheKey {
    pub fn new(
        principal: &Principal,
        action: &str,
        resource: Option<&serde_json::Value>,
        context: Option<&serde_json::Map<String, serde_json::Value>>,
    ) -> CacheKey {
        let resource = resource.map(|r| {
            let s = |k: &str| match r.get(k) {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => String::new(),
            };
            (s("type"), s("id"), hash_json(r))
        });
        CacheKey {
            principal_id: principal.id.clone(),
            principal: principal.fingerprint(),
            action: action.to_string(),
            resource,
            context: context.map_or(0, hash_json),
        }
    }
}

/// Hits, misses, and the hit rate, for the metrics endpoint.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub entries: usize,
}

impl CacheStats {
    pub fn hit_rate(&self) -> f64 {
        let total = self.hits + self.misses;
        if total == 0 {
            0.0
        } else {
            self.hits as f64 / total as f64
        }
    }
}

/// A bounded map of decisions. Full: emptied (a decision is cheap to
/// recompute; the cache is never a correctness boundary).
pub struct DecisionCache {
    map: Mutex<HashMap<CacheKey, (Decision, Instant)>>,
    capacity: usize,
    hits: AtomicU64,
    misses: AtomicU64,
}

impl Default for DecisionCache {
    fn default() -> Self {
        DecisionCache::new(100_000)
    }
}

impl DecisionCache {
    pub fn new(capacity: usize) -> DecisionCache {
        DecisionCache {
            map: Mutex::new(HashMap::new()),
            capacity: capacity.max(1),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    /// The cached decision for `key`, or `compute()` cached for `ttl`.
    pub fn get_or_compute(
        &self,
        key: CacheKey,
        ttl: Duration,
        compute: impl FnOnce() -> Decision,
    ) -> Decision {
        let now = Instant::now();
        if let Some((d, until)) = self.map.lock().expect("cache lock").get(&key)
            && *until > now
        {
            self.hits.fetch_add(1, Ordering::Relaxed);
            return d.clone();
        }
        self.misses.fetch_add(1, Ordering::Relaxed);
        let d = compute();
        let mut map = self.map.lock().expect("cache lock");
        if map.len() >= self.capacity {
            map.clear();
        }
        map.insert(key, (d.clone(), now + ttl));
        d
    }

    /// Drops every decision of `principal_id` (a role change, a logout).
    pub fn invalidate(&self, principal_id: &str) {
        self.map
            .lock()
            .expect("cache lock")
            .retain(|k, _| k.principal_id != principal_id);
    }

    /// Drops everything (a new deployment's policies).
    pub fn clear(&self) {
        self.map.lock().expect("cache lock").clear();
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            hits: self.hits.load(Ordering::Relaxed),
            misses: self.misses.load(Ordering::Relaxed),
            entries: self.map.lock().expect("cache lock").len(),
        }
    }
}
