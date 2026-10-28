# render-bench (B6 first cut, issue #11)

Measures the render stage of the shop medium page in Rust: the `shop` fixture of `crates/renox-template` (the B6 medium page from issue #9), compiled by `renox_template::Compiler` (#38), then once by minijinja, rendered with products that are already `minijinja::Value`. There is no HTTP, no SQLite and no isolate.

- `src/lib.rs`: the environment (layout, page, the `product_list` block as its own template, `money`/`date` stub filters, identity stubs for the compiler's `__loop` and `__url`); the render limits of `renox_template::Renderer` are not applied, so the numbers stay comparable with the first cut and deterministic products.
- `tests/output.rs`: the page is 20–30 KB with 100 cards; the fragment template equals the block rendered from the page; fuel does not change the output and a small budget stops the render.
- `benches/render.rs`: criterion. Full page at 100 and 1,000 items, the fragment two ways, and the page with fuel on.

```sh
cargo test -p render-bench
bench/run.sh B6 --profile dev-laptop --runs 3   # needs a B9 raw result for the render + marshal prediction
```

Latest numbers: `bench/results/*-B6-first-cut-*.md`.
