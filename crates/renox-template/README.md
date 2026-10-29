# renox-template

Attribute templates → minijinja (ADR D8, `docs/08-template-engine.md`). Leaf crate: no other `renox-*` crate, never links V8 (`cargo tree -p renox-template` shows no `v8` or `deno_core`). Promoted from the F0 prototype `bench/spike/template-proto` (#9), which is deleted.

```rust
// Deploy time (renox build, #43): the artifact's templates/ and manifest.templates.
let project = TemplateProject::from_dir(app_root)?;                       // pages/, partials/, modules/, overrides/
let compiled = Compiler::new(CompileOptions::default()).compile(&project)?; // Err(Vec<Diagnostic { file, line, col, message }>)
compiled.files();             // ("pages/index.jinja", source) ...
compiled.manifest_entries();  // { "pages/index": { "kind": "page", "fragments": { "news": { "target": "news" } } }, ... }

// Request time (renox-cell, #40): off the isolate thread.
let renderer = Renderer::new(compiled.sources())?;
let out = renderer.render(RenderTarget::Fragment { template: "pages/index", block: "news" }, data, &cx, &RenderLimits::DEFAULT)?;
out.html; out.fuel_used; out.ms;   // meter render_fuel, render_ms
```

Features: `compiler` (html5ever; builds for `wasm32-unknown-unknown` with `--no-default-features --features compiler`, for the CLI, #43) and `render` (fuel, filters, thread CPU time). Both are default; each builds alone (`--no-default-features --features compiler|render`).

## Layout

| Module | Role |
| --- | --- |
| `compiler::parse` | html5ever parse plus source positions (a `TreeSink` wrapper records element lines, a source scan finds attribute columns). Rewrites self-closing custom tags (`<slot />`, `<r-props />`, `<x-card />`, `<billing:badge />`) to open/close pairs first, since HTML ignores `/>` on them |
| `compiler::walker` | The tree walk that emits minijinja source: directives, components (inlined), slots, layouts, fragments |
| `compiler::expr` | Expression translation (`&&`, `\|\|`, `!`, `??`) and the DSL checks |
| `compiler::attrs` | `r-for` parsing, `:class` objects, boolean and URL attributes, escaping |
| `render` | `Renderer`, `RenderLimits`, `RenderContext`, `RenderError`, the `__renox` platform value |
| `filters` | `money`, `date`, `ago`, `number`, `truncate`, `json`, `upper`, `lower`, and the internal `__url` |
| `emit_js` | Render path B (ADR D7, #42): the compiled templates as one JavaScript module that renders in the isolate (see below) |

## Covered syntax

Every row of the syntax table in `docs/08-template-engine.md` has a fixture under `tests/fixtures/<row>/` (an app's template files) and a snapshot of the compiled output under `tests/snapshots/` (`tests/compile.rs`, `every_syntax_row_has_a_fixture`).

| Syntax | Output | Fixture |
| --- | --- | --- |
| `{{ expr }}` | `{{ expr }}` after translation and checks | `interpolation` |
| `{{ x \| money }}`, `a ?? b` | filters from the allowlist; `??` → `(a if a is defined and a is not none else b)` | `filter` |
| `r-html="expr"` | `{{ (expr) \| safe }}` as the content | `r-html` |
| `r-if`, `r-else-if`, `r-else` | `{% if %}{% elif %}{% else %}{% endif %}` | `condition` |
| `r-for="p in xs"`, `(p, i) in xs` | `{% for p in (xs) \| __loop %}` (the iteration limit); index via `loop.index0` | `loop`, `loop-index` |
| `r-empty="xs"` | `{% else %}` of the loop | `loop-empty`, `loop-table-rows` |
| `:attr`, `:class="{..}"`, boolean attributes | `attr="{{ e }}"`, class string with inline `{% if %}`, attribute only when truthy; URL attributes (`href`, `src`, `action`, `hx-get`, ...) go through `__url`, which replaces `javascript:` and every scheme but `http`, `https`, `mailto`, `tel` | `bind-attr`, `bind-class`, `bind-boolean` |
| `r-fragment="name"` | `{% block name %}` around the element (and its `r-if` chain); fragment map entry with the element's static `id` as `target` | `fragment` |
| `<r-group>` | no element | `group` |
| `<x-name :prop="e" flag>`, `<slot />`, `<slot name="x">fallback</slot>`, `slot="x"` on a child | inlined: props bound with `{% with %}`; slot content runs in the caller's scope (shadowed names restored) | `component` |
| `<r-props product="Product" compact="bool = false" />` | validated at the call site: unknown prop, missing required prop, a static value that is not a `bool`/`number`; a component that declares props may read only its props | `component` |
| `<r-layout use="main">` | `{% extends "pages/_layouts/main" %}`; children in `{% block content %}`, `slot="x"` children in `{% block x %}`; a layout's `<slot />` / `<slot name="x">` are those blocks (also inside `<title>`) | `layout` |
| `<r-slot name="admin.sidebar" />` | one `{% include %}` per filler in `CompileOptions::slots`, in order; a filler with `requires` is wrapped in `{% if can("<action>", none) %}` (#232) | `cross-module-slot`, `modules` |
| `r-can="action" :resource="x"`, `r-cannot` | `{% if can("action", x) %}` / `{% if not can(...) %}`; actions checked against `CompileOptions::actions` when given | `permission` |
| `<billing:plan-badge>` | the module partial, or its `overrides/billing/...` replacement | `module-component` |
| `modules/<m>/(pages\|partials)/….html` (#232, artifact 1.1) | template id `modules/<m>/…`, kind from the id without the prefix; `overrides/<m>/…` is compiled into that id instead; a module template's `<r-layout use="x">` finds `modules/<m>/pages/_layouts/x` before the app's | `modules` |
| `<script>` / `<style>` | content literal (`{% raw %}` when it has delimiters); `nonce="{{ __renox.csp_nonce }}"` added | `script-style` |
| `<x-form action="add">` | `<form method="post" action="?/add" hx-post="?/add" ...>` plus `<input type="hidden" name="_csrf" value="{{ __renox.csrf_token }}">`; other attributes kept (#41) | `render.rs::platform_components_carry_csrf_and_nonce` |
| `<x-csrf />` | the hidden `_csrf` input alone, for hand-written forms | same |
| `<x-script src="...">` | `<script src="..." nonce="...">` (empty element) | same |
| user text | `dir="auto"` on elements with interpolated text, `r-html`, text inputs with a bound `value` | `dir-auto` |
| static HTML | one chunk, one `EmitRaw` (`static_html_is_one_chunk`) | `static-merge` |

`hx-*`, `x-*`, `@*` and every other attribute pass through in source order.

### Diagnostics

`tests/diagnostics.rs`, each with file, line, and column: `r-else`/`r-else-if`/`r-empty` without their partner or with another list; invalid expressions; bad `r-for`; `r-if` with `r-for`; unknown directives and `r-*` elements; function calls, method calls, reserved `__` names, unknown filters and tests, `{% %}`/`{# #}` statements; fragment names, duplicates, duplicate targets, fragments inside loops or components (a block rendered alone would not see the loop variable); unknown components, props, slots, recursion; unknown layouts and layout slots; unknown or malformed `r-can` actions; a `nonce` attribute or bound `on*` handler; file paths that are no template (`pages/_x.html`, an override of nothing).

## Render limits

`RenderLimits::DEFAULT` (*proposed*, not per app): fuel 250,000, 100,000 iterations per render, 4 MiB output, include/extends depth 8, 200 ms. `RenderLimits::ERROR_PAGE` is the fixed error-page budget of `docs/contracts/errors.md` (10,000 fuel, 64 KiB, depth 4, 10 ms).

| Limit | Enforced by | Test (`tests/limits.rs`) |
| --- | --- | --- |
| Fuel | minijinja fuel (one environment per budget) | `b13_nested_loops_stop_at_fuel_within_50_ms` |
| Iterations | `__loop` adds each list's length to a per-render counter | `iteration_limit` |
| Output size | the writer refuses bytes past the limit | `output_size_limit` |
| Depth | longest extends/include chain, computed in `Renderer::new`; a cycle is infinite | `include_depth_limit` |
| Time | deadline checked at every write and loop start | `render_timeout` |

Measured on the shop list page (100 products, 26.1 KB, `tests/render.rs`): 4,770 fuel (1.9% of the default). B13 (`tests/fixtures/evil-nested-loops`, 10,000 × 10,000) stops at fuel after about 14 ms on the development container. These are test-run observations, not benchmark results (`docs/14-benchmarks.md`).

`RenderOutput::fuel_used` and `ms` (thread CPU time) are the meter's `render_fuel` and `render_ms`. On a limit other than fuel, `fuel_used` is the fuel seen at the last loop start, a lower bound.

## Runtime rules

- HTML auto-escaping everywhere; `/` is not escaped (minijinja's default does), `none`/`undefined` print nothing; undefined lookups chain (`a.b.c` on a missing `a` is empty, like `?.`).
- No global function except `can`, and no `range`, `namespace`, `debug`. The compiler rejects every call in tenant expressions anyway; this is the second layer.
- `__renox` (the platform value: CSP nonce, CSRF token, locale, limits, the `can` hook) comes from `RenderContext`, never from tenant data; a data key `__renox` is ignored.
- `r-can` without a `can` hook denies.

## Filters

Locales `en-AE` and `ar-AE`, Eastern Arabic digits with `ar-AE-u-nu-arab` (`Locale::parse`). Tests: `tests/filters.rs`, every filter in both locales.

| Filter | `en-AE` | `ar-AE` |
| --- | --- | --- |
| `money`, `money("SAR")` | `AED 1,234.50` | `1,234.50 د.إ.` / `١٬٢٣٤٫٥٠ د.إ.` |
| `number`, `number(2)` | `1,234,567.891` | same, or `١٬٢٣٤٬٥٦٨` |
| `date`, `date("short"\|"long"\|"datetime"\|"time")` | `29 Oct 2026`, `29/10/2026` | `29 أكتوبر 2026`, `29‏/10‏/2026` |
| `ago` | `3 minutes ago`, `in 2 hours` | `قبل 3 دقائق`, `خلال يومين` (CLDR plural categories) |
| `truncate(n, end="…")` | by characters | same |
| `json` | HTML-safe JSON (`<`, `>`, `&`, `'` as `\u00XX`) | same |
| `upper`, `lower` | case mapping | Arabic passes through |
| `t`, `t(count=n)`, `t({"count": n})` | the catalog message of the page's locale | same, with the Arabic plural categories |
| `phone_ae` | `+971 50 123 4567`, `+971 4 123 4567` | same, inside U+2066…U+2069 so it stays left to right |
| `emirates_id` | `784-1980-1234567-1` | same, isolated |
| `trn` | `100 2345 6789 0003` | same, isolated |

The GCC formatters only format: input they do not recognise is shown as given, and validation is the `gcc` module's TypeScript (#243).

### Translations (#233)

- **Catalogs**: `Catalogs::add(module, locale, json)` per `<locale>.json`; nested objects become dotted keys and a top-level `_meta` object is skipped (review marks). The app's catalogs override the modules'. `Renderer::with_catalogs` attaches them to a deployment's renderer. The cell reads `code/i18n/<locale>.json` (the app) and `code/modules/<name>/i18n/<locale>.json` (`crates/renox-cell/src/render.rs`).
- **Lookup**: the exact tag (`ar-AE`), then its language (`ar`), then `en`. A missing key renders the key itself and is reported once per deployment and `(locale, key)` through `Catalogs::on_missing` (the cell logs `i18n_missing`).
- **Messages**: an ICU MessageFormat subset: `{name}`, `{n, number}`, `{n, plural, =0 {…} one {# item} other {# items}}` (`zero`, `one`, `two`, `few`, `many`, `other`; CLDR rules of `en` and `ar`), `{g, select, a {…} other {…}}`, `''` and `'{…}'` quoting. A malformed message renders as written. Messages are text: the output is escaped like any value.
- **`<r-t key="cart.items" :count="cart.count" />`** compiles to `{{ "cart.items" | t({"count": (cart.count)}) }}`; plain attributes are text arguments.
- **`<html lang dir>`**: a template's `<html>` without `lang` or `dir` gets both from the render (`RenderContext::lang` and `dir`, from the page's `setLocale`, `ops.md` 1.3.0 section 14; defaults `en`, `ltr`, and `rtl` for `ar`, `fa`, `he`, `ur`, …). `dir="auto"` on user text is the compiler's (above).
- **Fuel**: a lookup is a filter call and costs fuel like any other (`tests/i18n.rs`).

The CLDR patterns for the two platform locales are written out in `src/filters/` instead of linking ICU (`icu`/`fixed_decimal`): two locales do not need the ICU data size or build time. `date` applies `RenderContext::utc_offset_minutes` (the app's zone; Asia/Dubai has no DST) to date-times, not to date-only values. Hijri display is not here.

## Not covered yet

- Built-in component `<x-image>` (storage module); module filters are accepted by name (`CompileOptions::filters`) but implemented by F4.
- `<slot>` inside `<head>` other than in `<title>` (the HTML parser moves unknown elements out of `<head>`).
- A layout using another layout.
- The fragment cache.
- Template size cap (`artifact.md` Open 4): compile time on large templates is not measured yet, so no cap is proposed.

## Render path B (`emit_js`)

`emit_js::emit_module(&compiled)` turns the same compiled templates path A renders into one ES module: `render(id, data, cx)` and `renderFragment(id, block, data, cx)`, where `cx` is `{ locale, csp_nonce, csrf_token, can }`. It parses each minijinja source with minijinja's own parser (`minijinja::machinery`, behind the `compiler` feature) and translates the syntax tree, so both paths start from the same source and the same compiler checks. `src/emit_js/runtime.js` reproduces the renderer: escaping, `none`/`undefined`, chainable lookups, truthiness, equality and ordering, value printing, the filters in both locales, `__url`. `examples/emit_js.rs` writes the module of an app directory (`bench/scenarios/B8`).

`tests/emit_js.rs` renders every fixture (pages, layouts, partials, every fragment) on both paths with four data sets (realistic, hostile strings and edge numbers, nulls, empty) and the three locales, and requires byte-equal HTML, or an error on both paths.

Not covered, refused with an `EmitError`: the `date`, `ago`, and `round` filters and module filters (the `filter` fixture), slices, `{% set %}` blocks, loop filters, tuple loop targets, computed `extends`/`include` names. Two known differences: an integral float computed by template arithmetic (`4 / 2`) prints `2.0` on path A and `2` on path B; a fragment on path A also fails when the rest of the page fails (path A evaluates the whole page first, B the block only).

Limits on path B: no fuel (V8 has no instruction counter). The isolate CPU limit is the bound, enforced in Rust by the runtime. The module also counts iterations (`__loop`, same 100,000) and output size against `RenderLimits::DEFAULT` and throws `RENOX_RENDER_LIMIT`. These two checks run in JavaScript and are a convenience, not the enforcement.

## For the CLI (#43)

`transpile::compile_json` is the compiler as one JSON call (`{ "files": {...} }` in; `{ "ok", "templates" }` or `{ "ok": false, "diagnostics" }` out). `renox-worker transpile` serves it on stdin/stdout, and that is what `renox build` uses. `src/wasm.rs` exposes the same call through a C ABI for a `wasm32-unknown-unknown` build (`bench/scenarios/B16/build-wasm.sh`). It was measured against the worker for the cold path and was slower (`cli/README.md`, "Templates"). It is kept so that measurement can be repeated, and is compiled only for `wasm32`.
