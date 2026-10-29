#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use renox_template::{CompileOptions, CompiledTemplates, Compiler, Diagnostic, TemplateProject};

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// `compile-options.json` of a fixture: `{ "slots": {..}, "actions": [..] }`.
pub fn options(dir: &Path) -> CompileOptions {
    let mut opts = CompileOptions::default();
    let Ok(raw) = std::fs::read_to_string(dir.join("compile-options.json")) else {
        return opts;
    };
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    if let Some(slots) = v.get("slots") {
        opts.slots = serde_json::from_value::<BTreeMap<String, Vec<renox_template::SlotFiller>>>(
            slots.clone(),
        )
        .unwrap();
    }
    if let Some(actions) = v.get("actions") {
        opts.actions = Some(serde_json::from_value::<BTreeSet<String>>(actions.clone()).unwrap());
    }
    opts
}

pub fn compile_fixture(name: &str) -> Result<CompiledTemplates, Vec<Diagnostic>> {
    let dir = fixtures_dir().join(name);
    let project = TemplateProject::from_dir(&dir).unwrap();
    Compiler::new(options(&dir)).compile(&project)
}

/// Compiles in-memory files.
pub fn compile_files(files: &[(&str, &str)]) -> Result<CompiledTemplates, Vec<Diagnostic>> {
    compile_with(files, CompileOptions::default())
}

pub fn compile_with(
    files: &[(&str, &str)],
    options: CompileOptions,
) -> Result<CompiledTemplates, Vec<Diagnostic>> {
    let mut project = TemplateProject::new();
    for (p, s) in files {
        project.insert(*p, *s);
    }
    Compiler::new(options).compile(&project)
}

pub fn show(diags: &[Diagnostic]) -> String {
    diags.iter().map(|d| format!("{d}\n")).collect()
}
