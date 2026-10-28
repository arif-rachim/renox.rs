//! Page routes (`docs/contracts/artifact.md` version 1, "Page routes" and
//! "Fragment selection"; `docs/contracts/ops.md` section 14). Pure Rust, no
//! V8.
//!
//! The runtime does not render (ADR D7, path A; gate F1 note on #40): for a
//! page route it runs `load` in the isolate, gets the data back as JSON
//! (`JSON.stringify` inside V8, the B9 path), and hands a [`PageRender`] to
//! the cell, which renders on its blocking pool with `renox-template`. So
//! render time is never in `cpu_ms`, and this crate does not depend on
//! `renox-template`.

use crate::manifest::{Manifest, RouteDef};

/// Largest loader result, as JSON (`ops.md` section 14, *proposed*).
pub const MAX_DATA_JSON_BYTES: usize = 8 * 1024 * 1024;

/// What the cell renders for one page request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRender {
    /// The page template id; `None` for a `.ts`-only page (which never
    /// produces a `PageRender`: an object from it is 500).
    pub template: Option<String>,
    /// The fragment selected by `HX-Target`, or `None` for the full page.
    pub fragment: Option<String>,
    /// The template data: the loader's object as JSON, `{}` without a loader.
    pub data_json: String,
    /// Out-of-band fragments to render after the main output (an action's
    /// `{ fragments }`, #41); empty after `load`.
    pub oob_fragments: Vec<String>,
}

/// Fragment selection, rule 1: `HX-Request: true` and an `HX-Target` equal to
/// the `target` of a fragment of the page's map selects that fragment.
/// Anything else renders the full page.
pub fn select_fragment(
    manifest: &Manifest,
    route: &RouteDef,
    headers: &http::HeaderMap,
) -> Option<String> {
    let template = route.page()?.template.as_ref()?;
    let htmx = headers
        .get("hx-request")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("true"));
    if !htmx {
        return None;
    }
    let target = headers.get("hx-target")?.to_str().ok()?;
    let target = target.strip_prefix('#').unwrap_or(target);
    let (_, def) = manifest.template_defs().find(|(id, _)| *id == template)?;
    def.fragments
        .as_ref()?
        .iter()
        .find(|(_, f)| f.target.as_deref() == Some(target))
        .map(|(name, _)| name.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        serde_json::from_value(serde_json::json!({
            "artifact": { "version": 1 },
            "app": { "name": "shop", "timezone": "Asia/Dubai" },
            "code": { "format": "esm-dir", "entry": { "pages/products": "pages/products.js" } },
            "routes": [
                { "kind": "page", "path": "/products", "module": "pages/products", "load": true, "template": "pages/products" }
            ],
            "templates": {
                "pages/products": { "kind": "page", "fragments": {
                    "product_list": { "target": "product-list" },
                    "related": { "target": null }
                } }
            },
            "permissions": { "network": [], "secrets": [] }
        }))
        .unwrap()
    }

    fn headers(pairs: &[(&str, &str)]) -> http::HeaderMap {
        let mut h = http::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn hx_target_selects_a_fragment() {
        let m = manifest();
        let r = &m.routes[0];
        let pick = |h: &[(&str, &str)]| select_fragment(&m, r, &headers(h));
        assert_eq!(
            pick(&[("hx-request", "true"), ("hx-target", "product-list")]),
            Some("product_list".into())
        );
        assert_eq!(
            pick(&[("hx-request", "true"), ("hx-target", "#product-list")]),
            Some("product_list".into())
        );
        // Rule 2: unknown target, no HX-Request, or a fragment without id.
        assert_eq!(pick(&[("hx-request", "true"), ("hx-target", "nope")]), None);
        assert_eq!(pick(&[("hx-target", "product-list")]), None);
        assert_eq!(
            pick(&[("hx-request", "true"), ("hx-target", "related")]),
            None
        );
        assert_eq!(pick(&[]), None);
    }

    #[test]
    fn page_routes_deserialise_with_their_shape() {
        let m = manifest();
        let r = &m.routes[0];
        assert_eq!(r.method, crate::manifest::Method::Get);
        assert_eq!(r.handler_export(), Some("load"));
        assert_eq!(
            r.page().unwrap().template.as_deref(),
            Some("pages/products")
        );
        let html_only: RouteDef = serde_json::from_value(
            serde_json::json!({ "kind": "page", "path": "/", "template": "pages/index" }),
        )
        .unwrap();
        assert_eq!(html_only.handler_export(), None);
        assert!(html_only.module.is_empty());
        let bad = serde_json::from_value::<RouteDef>(
            serde_json::json!({ "kind": "page", "path": "/", "template": "t", "method": "GET" }),
        );
        assert!(bad.is_err(), "unknown keys are refused");
    }
}
