# template-proto

F0 prototype of the template compiler (`docs/08-template-engine.md`, ADR D8, issue #9). It takes HTML with `r-*` directives and `:attr` bindings and produces minijinja source. `html5ever` parses the HTML and `minijinja` compiles and renders the result; this crate only walks the tree and emits source. Tests are string in, string out, and nothing links V8 (`cargo tree -p template-proto` shows no `v8` or `deno_core`).

```rust
let source: String = template_proto::transpile(html)?;          // Err(Vec<Diagnostic { line, col, message }>)
let out = template_proto::compile(html)?;                        // out.source, out.fragments: Vec<(fragment, block)>
```

`cargo run -p template-proto --example transpile < page.html` prints the output, or the diagnostics, for one file.

## Layout

| Module | Role | F2 destination |
| --- | --- | --- |
| `parse` | html5ever parse (document for layouts, `<template>`-context fragment otherwise), plus source positions: a `TreeSink` wrapper records each element's line, and a source scan finds the exact column of each attribute | `crates/renox-template` parser |
| `walker` | Tree walk; emits everything into one `String` | compiler core |
| `attrs` | Directive handlers: operator translation, `r-for` parsing, `:class` objects, boolean attributes, escaping | compiler core |

## Covered (F0 subset)

| Syntax | Output | Fixture |
| --- | --- | --- |
| `{{ expr }}` | Passed through unchanged | `interpolation` |
| `{{ }}` inside `<script>` / `<style>` | Kept literal with `{% raw %}` | `raw-script-style` |
| `r-if`, `r-else-if`, `r-else` | `{% if %}{% elif %}{% else %}{% endif %}` around the elements; whitespace between them is dropped | `if-chain` |
| `r-for="p in items"`, `r-for="(p, i) in items"` | `{% for %}`; the index is `{% set i = loop.index0 %}` | `for-simple`, `for-index` |
| `r-empty="items"` on the next sibling | `{% else %}` branch of the loop | `for-empty`, `table-rows` |
| `:attr="expr"` | `attr="{{ expr }}"` | `bind-attr` |
| `:class="{ 'a': cond, b: other }"` | Class string built with inline `{% if %}`, merged with a static `class` | `class-object` |
| `:disabled="expr"` and 23 other boolean attributes | Attribute emitted only when the expression is truthy | `boolean-attr` |
| `r-fragment="name"` | `{% block name %}` around the element (and around its `r-if` chain); fragment map returned | `fragment` |
| `<r-layout use="main">` | `{% extends "layouts/main.html" %}` with the children in `{% block body %}` | `layout` |
| `<r-group>` | No element; its directives apply to its children | `group` |
| `r-html="expr"` | `{{ expr \| safe }}` as the content | `r-html` |
| `hx-*`, `x-*`, `@*`, everything else | Unchanged, source order kept | `passthrough` |
| Static text | One contiguous chunk, which minijinja compiles to one `EmitRaw` (`tests/static_chunks.rs`) | `static-merge` |

Directive expressions accept the operators from `docs/08-template-engine.md` (`&&`, `||`, `!`) and translate them to minijinja's `and`, `or`, `not`. Each expression is compiled with `Environment::compile_expression` at transpile time, so a syntax error is reported at the attribute's line and column. `{{ }}` interpolation is passed through verbatim.

Diagnostics (`tests/diagnostics.rs`) cover:
- `r-else` / `r-else-if` without a preceding `r-if`;
- `r-empty` without `r-for`, or naming a different list;
- unknown `r-*` directives, and deferred ones (`r-can`, `r-cannot`);
- invalid expressions and invalid `r-for`;
- `r-if` together with `r-for` on one element (use `<r-group>`);
- duplicate fragments;
- components (`<x-*>`) and other `<r-*>` elements.

All diagnostics are collected and sorted by position.

`tests/fixtures/shop-products.html` is the B6 medium page, shared with B6 (#11) and B9 (#10): layout, a search form with `hx-*`, `r-for` over 100 products, `r-if` on stock, `:class`, `:disabled`, and `r-fragment="product_list"`. Rendered with 100 generated products of 10 fields each, it is about 25 KB (`tests/render_shop.rs`). The `product_list` block also renders on its own.

## Deferred to F2

- Components `<x-*>`, `<r-props>`, slots, `<r-slot>`, module components (`<billing:plan-badge>`).
- `r-can` / `r-cannot` and the `can()` function (needs `renox-authz`).
- Platform filters (`money`, `date`, `t`, ...): the tests register stubs. Locale and RTL handling.
- Render fuel, iteration and output limits, render timeout (B13).
- `??`, and translating operators inside `{{ }}` interpolation.
- `javascript:` URL checks on `:href`, CSP nonce injection, `<x-form>` / `<x-csrf>`.
- Layout syntax: layouts are written as documents with a literal `{% block body %}{% endblock %}` (`tests/fixtures/layouts/main.html`).
- Streaming, the fragment cache, and file names in diagnostics (positions are line and column within one file).

Known prototype limits:
- In fragment mode, html5ever's `<template>` context picks its insertion mode from the first tag. A fragment that starts with `<p>` and later has a bare `<tr>` loses the row; inside a `<table>` it is fine.
- minijinja's HTML escaping also escapes `/` (`&#x2f;`), which makes URL-heavy output larger.
