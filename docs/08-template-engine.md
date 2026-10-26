# 08 — Template engine

Templates are valid HTML with logic expressed as attributes. At deploy time the attribute syntax is transpiled to minijinja source, compiled, and cached. At request time Rust only executes the compiled template. The syntax does not affect speed; the compiler and the data marshaling do.

```html
<r-layout use="main">
  <ul id="product-list" r-fragment="product_list">
    <li r-for="p in products" class="card" :class="{ 'card--empty': p.stock == 0 }">
      <a href="/products/{{ p.id }}">{{ p.name }}</a>
      <span r-if="p.stock == 0">Out of stock</span>
      <span r-else>{{ p.price | money }}</span>
      <button r-can="cart.add" :resource="p" hx-post="?/addToCart" hx-vals='{"productId": "{{ p.id }}"}'>Add</button>
    </li>
    <li r-empty="products">No products found</li>
  </ul>
</r-layout>
```

## Syntax

| Need | Syntax | Transpiles to |
| --- | --- | --- |
| Interpolation (auto-escaped) | `{{ user.name }}` | same |
| Filter | `{{ p.price \| money }}` | same |
| Raw HTML | `r-html="post.body"` | `{{ post.body \| safe }}` |
| Condition | `r-if`, `r-else-if`, `r-else` | `{% if %}` |
| Loop | `r-for="p in items"`, `r-for="(p, i) in items"` | `{% for %}` |
| Empty list | `r-empty="items"` | `{% else %}` inside `for` |
| Dynamic attribute | `:href="url"`, `:disabled="!ok"`, `:class="{ active: x }"` | attribute expressions |
| Fragment for partial render | `r-fragment="name"` | `{% block name %}` |
| Wrapper without output | `<r-group r-if="...">` | no element emitted |
| Component | `<x-product-card :product="p" compact>`, `<slot />`, `<slot name="actions" />` | macro, inlined at compile time |
| Component props | `<r-props product="Product" compact="bool = false" />` | validated at compile time |
| Layout | `<r-layout use="main">` | `{% extends %}` |
| Cross-module slot | `<r-slot name="admin.sidebar" />` | include from the slot registry |
| Permission | `r-can="action" :resource="x"`, `r-cannot` | `{% if can(...) %}` (see `11-authorization.md`) |
| Module component | `<billing:plan-badge :user="user" />` | namespaced macro |

`r-*` and `:*` attributes are removed from the output; `hx-*` and `x-*` are passed through. Interpolation uses `{{ }}` because single braces clash with `x-data="{ open: false }"` and `hx-vals='{...}'`; interpolation is not processed inside `<script>` and `<style>`.

## Right-to-left and bilingual output

Arabic is a first-class target (`21-uae-gcc-strategy.md`), so RTL is a template-engine requirement, not a theme concern:

- The layout sets `<html lang dir>` from the active locale; `dir="auto"` is emitted on user-generated text fields.
- Platform CSS and all official module templates use logical properties (`margin-inline-start`, `padding-inline-end`, `text-align: start`) and are snapshot-tested in both `ltr` and `rtl`.
- Built-in components (`<x-form>`, `<x-image>`, admin tables, pagination, date pickers) mirror correctly; icons that imply direction have RTL variants.
- Filters `money`, `date`, `number` follow the locale (AED formatting, Eastern Arabic digits optional, Hijri display optional); `t` resolves translations with Arabic plural categories.
- Bilingual documents (invoices, emails) are rendered from one template with side-by-side EN/AR blocks; PDF rendering uses fonts with Arabic shaping.

## Built-in components

Some components are provided by the platform or official modules and are compiled, not interpreted:

| Component | Provided by | Emits |
| --- | --- | --- |
| `<x-image :src="file" width="400" alt="...">` | `storage` module | `<img>` with `srcset` (1x/2x), `width`/`height` from stored metadata, `loading="lazy"`, `decoding="async"`, and URLs to the image pipeline (`06-data.md`, `18-build-plan.md` M6). Options: `fit="cover|contain"`, `focus="face|center"`, `placeholder="blur"`, `sizes="..."` |
| `<x-form action="addToCart">` | platform | `<form>` with the CSRF token, `hx-post`, and `hx-target` wired to the action's declared fragments |
| `<x-csrf />` | platform | Hidden CSRF input for hand-written forms |
| `<x-script src="...">` | platform | `<script>` with the per-request CSP nonce |

## The expression language is deliberately small

Property access, literals, comparisons, `&&`, `||`, `!`, `??`, and filters. No free function calls, assignment, or side effects. Logic that does not fit goes into the TypeScript loader. Because templates are a DSL with no code execution, tenant templates can be evaluated safely on Rust threads.

Filters are provided by the platform (`money`, `date`, `ago`, `number`, `truncate`, `json`, `upper`, `lower`) and by modules (declared in the manifest, implemented in Rust or as pure TS functions precomputed in the loader).

## Compile pipeline (deploy time)

1. Parse HTML with `html5ever`.
2. Resolve layouts, components, slots, and module overrides.
3. Validate: `r-else` without `r-if`, unknown components, bad props, invalid expressions, unknown actions in `r-can`, unknown fragments. Errors report file and line.
4. Emit minijinja source; let minijinja compile it. Consecutive static text becomes one chunk.
5. Record the fragment map (fragment name → block name → page) for htmx routing.

At request time the renderer executes the compiled template and writes into a single output buffer. No parsing on the request path.

## Where render time goes

For a 20–30 KB page with 100 items (estimates; must be measured, see `14-benchmarks.md`):

| Stage | Cost |
| --- | --- |
| Parse and compile | 0 on the request path (deploy time) |
| Instruction execution | ~20–100 µs |
| Escaping (SIMD) + buffer writes | ~15–40 µs |
| **Marshaling loader data V8 → Rust** (`serde_v8`) | **~50–300 µs** |

The largest cost is not the engine but marshaling. Comparables: React `renderToString` 2–10 ms, Svelte SSR 0.5–2 ms, Hono JSX 0.3–1 ms.

## Two render paths, decided by benchmark (D7)

| | A. Render in Rust (minijinja) | B. Compile the template to a JS function, run in the isolate |
| --- | --- | --- |
| Marshaling | Yes | No; data used directly |
| Execution | Rust interpreter over dynamic values | V8 JIT, fast once warm |
| Tenant CPU and heap | **Not charged** to the tenant quota | Charged |
| Safety | DSL evaluated by the platform | Same DSL, compiled by the platform |
| Wins when | Small to medium data, large pages, fragments | Very large data sets |

For multi-tenant hosting, path A has a non-technical advantage: rendering is done by the platform, the tenant isolate is free as soon as the loader returns, and the tenant heap stays small. Path B is kept for data-heavy pages. The default is chosen by the F2 benchmark.

## Optimizations and limits

- Static chunks are merged; a 500-node page becomes tens of instructions.
- Fragment requests render one block only, and the loader is told which fragment was requested so it can skip unneeded queries.
- Marshaling goes directly to `minijinja::Value`, without a JSON intermediate.
- Streaming: the `<head>` and layout shell are sent while the loader awaits the database.
- Fragment cache keyed by hash(data) + hash(user permission set); fragments containing resource-based `r-can` are never cached across users.
- Tenant templates can be a DoS vector (nested 10,000 × 10,000 loops on a Rust thread). Mandatory: minijinja `fuel`, iteration limit, output size limit, include depth limit, render timeout charged to the tenant quota.

## Secondary option: TSX

A loader may return JSX rendered inside the isolate. For teams that prefer the React style. It uses the tenant quota, so it is not the default.
