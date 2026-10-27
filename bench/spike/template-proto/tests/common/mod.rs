//! Shared test helpers: an environment with the shop layout and stub filters.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use minijinja::{Environment, Value};

pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

pub fn read(name: &str) -> String {
    std::fs::read_to_string(fixtures().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

/// Environment with `layouts/main.html` (transpiled) and stub `money`/`date`
/// filters, as issue #9 asks for the end-to-end test.
pub fn env() -> Environment<'static> {
    let mut env = Environment::new();
    env.set_auto_escape_callback(|_| minijinja::AutoEscape::Html);
    let layout = template_proto::transpile(&read("layouts/main.html")).expect("layout transpiles");
    env.add_template_owned("layouts/main.html", layout)
        .expect("layout compiles");
    env.add_filter("money", |v: Value| {
        format!("AED {:.2}", f64::try_from(v).unwrap_or(0.0))
    });
    env.add_filter("date", |v: Value| v.to_string());
    env
}
