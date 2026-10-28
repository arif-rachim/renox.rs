//! Renox templates (`docs/08-template-engine.md`, ADR D8).
//!
//! Templates are valid HTML with logic in attributes (`r-if`, `r-for`,
//! `:attr`, components, layouts). At deploy time the [`Compiler`] turns a
//! [`TemplateProject`] into minijinja sources plus the fragment map
//! ([`CompiledTemplates`], the `templates/` tree and `manifest.templates` of
//! `docs/contracts/artifact.md` version 1). At request time the
//! [`Renderer`] executes those sources under the render limits
//! ([`RenderLimits`]) with the platform filters.
//!
//! Features: `compiler` (html5ever; builds for Wasm, #43) and `render`
//! (minijinja with fuel, the filters, thread CPU time). Both are default.
//!
//! The expression language is a DSL with no code execution: property
//! access, literals, comparisons, `&&`, `||`, `!`, `??`, tests, and filters.
//! The compiler rejects free function calls, method calls, and reserved
//! (`__`-prefixed) names; the renderer registers no global function other
//! than the compiler-emitted `can`.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

#[cfg(feature = "compiler")]
pub mod compiler;
#[cfg(feature = "compiler")]
pub mod emit_js;
pub mod error_page;
#[cfg(feature = "render")]
pub mod filters;
#[cfg(feature = "render")]
pub mod render;
pub mod shell;
#[cfg(feature = "compiler")]
pub mod transpile;
#[cfg(all(feature = "compiler", target_arch = "wasm32"))]
pub mod wasm;

#[cfg(feature = "compiler")]
pub use compiler::{CompileOptions, Compiler, TemplateProject};
pub use error_page::ErrorPage;
/// The minijinja version the renderer is built on (for `Value`).
#[cfg(feature = "render")]
pub use minijinja;
#[cfg(feature = "render")]
pub use render::{
    CanFn, Locale, RenderContext, RenderError, RenderLimits, RenderOutput, RenderTarget, Renderer,
};
pub use shell::Shell;

/// The name of the platform value the compiler emits and the renderer
/// provides (CSP nonce, locale, limits). Tenant expressions cannot name it.
pub const PLATFORM_VAR: &str = "__renox";

/// A compile error with its position: the app-relative file, 1-based line
/// and column (in characters).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Diagnostic {
    pub file: String,
    pub line: usize,
    pub col: usize,
    pub message: String,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}:{}: {}",
            self.file, self.line, self.col, self.message
        )
    }
}

/// `manifest.templates[id].kind` (`docs/contracts/artifact.md`, "Templates").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateKind {
    /// A page route's template: any `pages/**` id whose last segment does
    /// not start with `_`.
    Page,
    /// `pages/_layouts/*`.
    Layout,
    /// `partials/*`: components, slot providers, `ctx.render`.
    Partial,
    /// `pages/_error`.
    Error,
    /// `pages/_404`.
    NotFound,
}

impl TemplateKind {
    /// The kind a template id must have (V14), or `None` for an id that is
    /// no template (`pages/_other`).
    pub fn of_id(id: &str) -> Option<TemplateKind> {
        let last = id.rsplit('/').next().unwrap_or("");
        if id.starts_with("partials/") {
            Some(TemplateKind::Partial)
        } else if let Some(rest) = id.strip_prefix("pages/_layouts/") {
            (!rest.contains('/')).then_some(TemplateKind::Layout)
        } else if id == "pages/_error" {
            Some(TemplateKind::Error)
        } else if id == "pages/_404" {
            Some(TemplateKind::NotFound)
        } else if id.starts_with("pages/") && !last.starts_with('_') {
            Some(TemplateKind::Page)
        } else {
            None
        }
    }
}

/// One entry of a page's fragment map. The fragment name is also the
/// minijinja block name it compiles to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fragment {
    /// The static `id` of the element that carries `r-fragment`, matched
    /// against `HX-Target`; `None` when it has none.
    pub target: Option<String>,
}

/// One compiled template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CompiledTemplate {
    pub kind: TemplateKind,
    /// minijinja source (`templates/<id>.jinja`).
    pub source: String,
    /// Pages only: every fragment reachable when rendering the page,
    /// including those of its layout and of inlined components.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragments: Option<BTreeMap<String, Fragment>>,
}

/// The output of [`Compiler::compile`]: template id -> compiled template.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CompiledTemplates {
    pub templates: BTreeMap<String, CompiledTemplate>,
}

impl CompiledTemplates {
    /// `manifest.templates` of artifact version 1: id -> `{ kind, fragments }`.
    pub fn manifest_entries(&self) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> = self
            .templates
            .iter()
            .map(|(id, t)| {
                let mut entry = serde_json::json!({ "kind": t.kind });
                if let Some(fragments) = &t.fragments {
                    entry["fragments"] = serde_json::to_value(fragments).expect("fragments");
                }
                (id.clone(), entry)
            })
            .collect();
        serde_json::Value::Object(map)
    }

    /// The `templates/` files: `(path, source)` with `path = <id>.jinja`.
    pub fn files(&self) -> impl Iterator<Item = (String, &str)> {
        self.templates
            .iter()
            .map(|(id, t)| (format!("{id}.jinja"), t.source.as_str()))
    }

    /// The `(id, source)` pairs a [`Renderer`] is built from.
    pub fn sources(&self) -> impl Iterator<Item = (&str, &str)> {
        self.templates
            .iter()
            .map(|(id, t)| (id.as_str(), t.source.as_str()))
    }
}

/// The fragment of `page` selected by an `HX-Target` value
/// (`docs/contracts/artifact.md`, "Fragment selection"): the name whose
/// `target` equals it.
pub fn fragment_for_target<'a>(
    fragments: &'a BTreeMap<String, Fragment>,
    hx_target: &str,
) -> Option<&'a str> {
    let target = hx_target.strip_prefix('#').unwrap_or(hx_target);
    fragments
        .iter()
        .find(|(_, f)| f.target.as_deref() == Some(target))
        .map(|(name, _)| name.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_follow_v14() {
        assert_eq!(TemplateKind::of_id("pages/index"), Some(TemplateKind::Page));
        assert_eq!(
            TemplateKind::of_id("pages/products/[id]"),
            Some(TemplateKind::Page)
        );
        assert_eq!(
            TemplateKind::of_id("pages/_layouts/main"),
            Some(TemplateKind::Layout)
        );
        assert_eq!(
            TemplateKind::of_id("pages/_error"),
            Some(TemplateKind::Error)
        );
        assert_eq!(
            TemplateKind::of_id("pages/_404"),
            Some(TemplateKind::NotFound)
        );
        assert_eq!(
            TemplateKind::of_id("partials/card"),
            Some(TemplateKind::Partial)
        );
        assert_eq!(TemplateKind::of_id("pages/_other"), None);
        assert_eq!(TemplateKind::of_id("pages/a/_x"), None);
        assert_eq!(TemplateKind::of_id("lib/x"), None);
    }

    #[test]
    fn target_lookup_accepts_a_hash() {
        let mut m = BTreeMap::new();
        m.insert(
            "product".to_string(),
            Fragment {
                target: Some("product".into()),
            },
        );
        m.insert("related".to_string(), Fragment { target: None });
        assert_eq!(fragment_for_target(&m, "product"), Some("product"));
        assert_eq!(fragment_for_target(&m, "#product"), Some("product"));
        assert_eq!(fragment_for_target(&m, "related"), None);
    }
}
