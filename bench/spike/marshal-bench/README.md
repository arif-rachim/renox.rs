# marshal-bench (B9, issue #10)

Measures the cost of turning loader data living in V8 (100 products × 10 fields) into a `minijinja::Value`. The result is the input to ADR D7, render in Rust.

- `src/lib.rs`: the sample data (`PRODUCTS_JS`), a V8 `Sandbox`, and the conversion paths: `via_serde_json`, `via_struct`, `via_walker`, `via_json_string`, plus the extra `via_json_string_struct`.
- `tests/equality.rs`: all paths produce the same `minijinja::Value` and render the same.
- `benches/marshal.rs`: criterion, every path at 10, 100 and 1,000 items.

```sh
cargo test -p marshal-bench
cargo bench -p marshal-bench                       # ad hoc
bench/run.sh B9 --profile dev-laptop --runs 3      # recorded result
```

V8 comes from the prebuilt `rusty_v8` static library. The B9 results were measured on `v8` 130.0.7, the version of the pinned Edge Runtime; the crate now builds on `v8` 150.4.0, the one `crates/renox-runtime` uses, because a workspace can link only one `v8` version (see that crate's README). Do not set `V8_FROM_SOURCE`.

The latest numbers and the recommended F2 path are in `bench/results/*-B9-*.md`.
