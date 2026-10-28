//! Render path B module of an app (#42, B8): compiles the app's templates
//! as `renox build` does, then writes the JavaScript module of
//! `renox_template::emit_js` to stdout.
//!
//! cargo run -p renox-template --example emit_js -- <app dir> > templates.mjs

use std::path::PathBuf;
use std::process::ExitCode;

use renox_template::emit_js::emit_module;
use renox_template::{CompileOptions, Compiler, TemplateProject};

fn main() -> ExitCode {
    let Some(dir) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: emit_js <app dir>");
        return ExitCode::from(2);
    };
    let project = match TemplateProject::from_dir(&dir) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{}: {e}", dir.display());
            return ExitCode::FAILURE;
        }
    };
    let compiled = match Compiler::new(CompileOptions::default()).compile(&project) {
        Ok(c) => c,
        Err(diags) => {
            for d in diags {
                eprintln!("{d}");
            }
            return ExitCode::FAILURE;
        }
    };
    match emit_module(&compiled) {
        Ok(js) => {
            print!("{js}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
