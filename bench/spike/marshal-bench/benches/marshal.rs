//! B9 (issue #10): criterion benchmark of the marshaling paths at 10,
//! 100 and 1,000 products. The 100-item case is judged against B9.
//! Each iteration opens a fresh handle scope, as a render call would, so
//! handles created by a path do not pile up across iterations.

use std::hint::black_box;

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use marshal_bench::{
    Sandbox, via_json_string, via_json_string_struct, via_serde_json, via_struct, via_walker,
};

type Path = for<'s, 'i> fn(&mut v8::PinScope<'s, 'i>, v8::Local<'s, v8::Value>) -> minijinja::Value;

const PATHS: [(&str, Path); 5] = [
    ("serde_json", via_serde_json),
    ("struct", via_struct),
    ("walker", via_walker),
    ("json_string", via_json_string),
    // Extra, not in the issue: see the crate docs.
    ("json_string_struct", via_json_string_struct),
];

fn marshal(c: &mut Criterion) {
    let mut sandbox = Sandbox::new();
    let mut group = c.benchmark_group("B9");
    for n in [10, 100, 1000] {
        sandbox.with_products(n, |scope, products| {
            for (name, path) in PATHS {
                group.bench_with_input(BenchmarkId::new(name, n), &n, |b, _| {
                    b.iter(|| {
                        v8::scope!(let scope, scope);
                        black_box(path(scope, black_box(products)))
                    })
                });
            }
        });
    }
    group.finish();
}

criterion_group!(benches, marshal);
criterion_main!(benches);
