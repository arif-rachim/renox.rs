//! B-series micro-benchmark for `docs/11-authorization.md`, "Performance"
//! (#276): one decision at 200 policies with a principal holding 20 roles,
//! cold (entities built and Cedar evaluated) and cached (the decision
//! cache's lookup, key hashing included). Targets: cold ≤ 500 µs, cached
//! ≤ 50 µs. Run: `cargo bench -p renox-authz --bench eval`.

use std::hint::black_box;
use std::time::Duration;

use criterion::{Criterion, criterion_group, criterion_main};
use renox_authz::{
    AttrType, AuthzBlock, CacheKey, DecisionCache, Engine, MergedSchema, Owner, PlatformContext,
    PolicySet, Principal,
};
use serde_json::json;

fn setup() -> (Engine, Principal, serde_json::Value) {
    let actions: Vec<String> = (0..40).map(|i| format!("res{i}.act")).collect();
    let authz: AuthzBlock = serde_json::from_value(json!({
        "actions": actions,
        "sensitive": ["res0.act"],
        "entities": { "Doc": { "attrs": ["owner", "org", "amount", "status"] } },
    }))
    .unwrap();
    let owner = Owner::new("app", authz).with_type("Doc", "amount", AttrType::Long);
    let schema = MergedSchema::build(&[owner], None).unwrap();
    // 200 policies: role grants with attribute conditions, ownership, and forbids.
    let mut text = String::new();
    for i in 0..200 {
        let a = i % 40;
        let r = i % 25;
        match i % 4 {
            0 => text.push_str(&format!(
                "permit (principal in Renox::Role::\"role{r}\", action == Renox::Action::\"res{a}.act\", resource is App::Doc) when {{ resource.org == principal.org }};\n"
            )),
            1 => text.push_str(&format!(
                "permit (principal is Renox::User, action == Renox::Action::\"res{a}.act\", resource is App::Doc) when {{ resource.owner == principal.org && resource.amount < {i}000 }};\n"
            )),
            2 => text.push_str(&format!(
                "forbid (principal, action == Renox::Action::\"res{a}.act\", resource is App::Doc) when {{ resource.status == \"locked{i}\" }};\n"
            )),
            _ => text.push_str(&format!(
                "forbid (principal, action == Renox::Action::\"res{a}.act\", resource) unless {{ context.mfa_verified || principal in Renox::Role::\"role{r}\" }};\n"
            )),
        }
    }
    let set = PolicySet::load(&[("policies/app/bench.cedar".into(), text)], &schema)
        .unwrap_or_else(|e| panic!("{e:#?}"));
    assert_eq!(set.len(), 200);
    let mut p = Principal::user("u_bench")
        .with_attr("org", json!("o_1"))
        .with_attr("mfa_verified", json!(true));
    for r in 0..20 {
        p = p.with_role(&format!("role{r}"), "global", None);
    }
    let doc = json!({ "type": "Doc", "id": "d_1", "owner": "u_x", "org": "o_1", "amount": 5, "status": "open" });
    (Engine::new(schema, set), p, doc)
}

fn bench(c: &mut Criterion) {
    let (engine, principal, doc) = setup();
    let platform = PlatformContext {
        now_ms: 1_700_000_000_000,
        request: Some(("GET".into(), "/docs/d_1".into())),
    };
    assert!(
        engine
            .check(&principal, "res4.act", Some(&doc), None, None, &platform)
            .allow
    );
    c.bench_function("authz/cold/200-policies-20-roles", |b| {
        b.iter(|| {
            black_box(engine.check(
                black_box(&principal),
                "res4.act",
                Some(black_box(&doc)),
                None,
                None,
                &platform,
            ))
        })
    });
    let cache = DecisionCache::default();
    let ttl = Duration::from_secs(60);
    c.bench_function("authz/cached/200-policies-20-roles", |b| {
        b.iter(|| {
            let key = CacheKey::new(
                black_box(&principal),
                "res4.act",
                Some(black_box(&doc)),
                None,
            );
            black_box(cache.get_or_compute(key, ttl, || {
                engine.check(&principal, "res4.act", Some(&doc), None, None, &platform)
            }))
        })
    });
}

criterion_group! {
    name = benches;
    config = Criterion::default().measurement_time(Duration::from_secs(5));
    targets = bench
}
criterion_main!(benches);
