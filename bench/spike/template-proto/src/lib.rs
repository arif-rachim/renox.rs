//! F0 prototype of the attribute-template → minijinja transpiler
//! (`docs/08-template-engine.md`, ADR D8, issue #9).
//!
//! Input is valid HTML with `r-*` directives and `:attr` bindings; output is
//! minijinja source. Parsing is done by `html5ever`, compiling and rendering
//! by `minijinja`; this crate only walks the tree and emits source.
//!
//! Layout so F2 can promote it into `crates/renox-template`:
//! - [`parse`]: html5ever parsing plus source positions for diagnostics.
//! - [`walker`]: the tree walk that emits minijinja source.
//! - [`attrs`]: directive and attribute handlers (`r-for`, `:class`, ...).

pub mod attrs;
pub mod parse;
pub mod walker;

use std::fmt;

/// A compile error in the template, with a 1-based position in the input.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub struct Diagnostic {
    pub line: usize,
    pub col: usize,
    pub message: String,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.col, self.message)
    }
}

/// The result of a successful transpile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    /// minijinja source.
    pub source: String,
    /// `(fragment_name, block_name)` for every `r-fragment`, in document order.
    pub fragments: Vec<(String, String)>,
}

/// Transpiles one template to minijinja source.
pub fn transpile(html: &str) -> Result<String, Vec<Diagnostic>> {
    compile(html).map(|out| out.source)
}

/// Transpiles one template and also returns the fragment map.
pub fn compile(html: &str) -> Result<Output, Vec<Diagnostic>> {
    let doc = parse::parse(html);
    walker::emit(&doc)
}
