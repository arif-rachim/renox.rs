//! The transpiler as one JSON call, for the CLI (#43): the same function is
//! reached through `renox-worker transpile` (stdin/stdout) and through the
//! Wasm build of this crate (`wasm.rs`), so both paths give the CLI the same
//! bytes.
//!
//! Input: `{ "files": { "<app-relative path>": "<source>", ... } }` (the
//! `pages/`, `partials/`, `modules/`, `overrides/` HTML files).
//!
//! Output: `{ "ok": true, "templates": { "<id>": { "kind", "source",
//! "fragments"? } } }`, or `{ "ok": false, "diagnostics": [{ "file", "line",
//! "col", "message" }] }`. A malformed input is one diagnostic with an
//! empty `file`.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::{Compiler, Diagnostic, TemplateProject};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    files: BTreeMap<String, String>,
}

/// Compiles the files of `input` (JSON) and returns the result as JSON.
pub fn compile_json(input: &str) -> String {
    let input: Input = match serde_json::from_str(input) {
        Ok(i) => i,
        Err(e) => {
            return failure(&[Diagnostic {
                file: String::new(),
                line: 0,
                col: 0,
                message: format!("transpiler input: {e}"),
            }]);
        }
    };
    let mut project = TemplateProject::new();
    for (path, source) in input.files {
        project.insert(path, source);
    }
    match Compiler::default().compile(&project) {
        Ok(compiled) => {
            serde_json::json!({ "ok": true, "templates": compiled.templates }).to_string()
        }
        Err(diags) => failure(&diags),
    }
}

fn failure(diags: &[Diagnostic]) -> String {
    serde_json::json!({ "ok": false, "diagnostics": diags }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_and_reports() {
        let ok: serde_json::Value = serde_json::from_str(&compile_json(
            r#"{"files":{"pages/index.html":"<p r-fragment=\"x\" id=\"x\">{{ a }}</p>"}}"#,
        ))
        .unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["templates"]["pages/index"]["kind"], "page");
        assert_eq!(
            ok["templates"]["pages/index"]["fragments"]["x"]["target"],
            "x"
        );
        let bad: serde_json::Value = serde_json::from_str(&compile_json(
            r#"{"files":{"pages/index.html":"<p>\n{{ f(1) }}</p>"}}"#,
        ))
        .unwrap();
        assert_eq!(bad["ok"], false);
        assert_eq!(bad["diagnostics"][0]["file"], "pages/index.html");
        assert_eq!(bad["diagnostics"][0]["line"], 2);
        let junk: serde_json::Value = serde_json::from_str(&compile_json("nope")).unwrap();
        assert_eq!(junk["ok"], false);
    }
}
