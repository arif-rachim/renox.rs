//! Module loader restricted to one artifact (`docs/contracts/ops.md`
//! section 11, step 4; `docs/contracts/artifact.md` section 1).
//!
//! Tenant modules are addressed with a **virtual** `file:///` root: the
//! module `code/functions/api/hello.js` is `file:///functions/api/hello.js`,
//! the same specifier it has inside `bundle.eszip`. `import.meta.url` and
//! error stacks therefore never show a path of the machine.
//!
//! Refused: any scheme other than `file:` (no `http:`, `https:`, `data:`,
//! `npm:`, `jsr:`), any path that escapes `code/` (checked on the
//! specifier and again on the canonical path, so a symbolic link created
//! after the load-time check cannot escape either), and files that are not
//! `.js`, `.mjs`, or `.json`. `node:` built-ins resolve to Deno's polyfills,
//! which are already in the isolate; with every permission denied their I/O
//! fails (ops.md section 11, global table). `ext:` specifiers are refused by
//! `deno_core` itself for non-`ext:` referrers.
//!
//! `node:` built-ins: tenant modules may import only the compute-only ones
//! in [`NODE_ALLOWED`]. Everything that reaches the process, the file
//! system, the network, other contexts, or high-resolution timers
//! (`node:fs`, `node:net`, `node:http`, `node:child_process`,
//! `node:process`, `node:os`, `node:vm`, `node:v8`, `node:perf_hooks`,
//! `node:worker_threads`, ...) is refused at resolution. This is stricter
//! than `ops.md` section 11 ("importable, every I/O call fails"); see the
//! README, "Hidden globals".
//!
//! `npm:` dependencies are not resolved at runtime: the CLI vendors them
//! into the artifact (esm-dir, #32) or the eszip bundles them (README,
//! "Module loader").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use deno_core::{
    ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader, ModuleSource,
    ModuleSourceCode, ModuleSpecifier, ModuleType, RequestedModuleType, ResolutionKind,
};
use deno_error::JsErrorBox;

use crate::manifest::check_relative_path;

/// The virtual root of tenant module specifiers.
pub const VIRTUAL_ROOT: &str = "file:///";

/// Turn an artifact-relative module path into its specifier.
pub fn specifier_for(path: &str) -> Result<ModuleSpecifier, JsErrorBox> {
    check_relative_path(path)
        .map_err(|r| JsErrorBox::generic(format!("invalid module path: {r}")))?;
    ModuleSpecifier::parse(&format!("{VIRTUAL_ROOT}{path}")).map_err(JsErrorBox::from_err)
}

/// The artifact-relative path of a tenant specifier, after the path rules.
fn relative_path(specifier: &ModuleSpecifier) -> Result<String, JsErrorBox> {
    if specifier.scheme() != "file"
        || specifier.host().is_some()
        || specifier.query().is_some()
        || specifier.fragment().is_some()
    {
        return Err(JsErrorBox::generic("module specifier not allowed"));
    }
    let path = specifier.path().strip_prefix('/').unwrap_or("");
    let decoded =
        percent_decode(path).ok_or_else(|| JsErrorBox::generic("module specifier not allowed"))?;
    check_relative_path(&decoded)
        .map_err(|_| JsErrorBox::generic("module specifier not allowed"))?;
    Ok(decoded)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn module_type_for(path: &str) -> Result<ModuleType, JsErrorBox> {
    if path.ends_with(".js") || path.ends_with(".mjs") {
        Ok(ModuleType::JavaScript)
    } else if path.ends_with(".json") {
        Ok(ModuleType::Json)
    } else {
        Err(JsErrorBox::generic("module type not allowed"))
    }
}

/// `node:` built-ins tenant modules may import (compute only).
pub const NODE_ALLOWED: &[&str] = &[
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "diagnostics_channel",
    "events",
    "path",
    "path/posix",
    "path/win32",
    "punycode",
    "querystring",
    "stream",
    "stream/consumers",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "timers",
    "timers/promises",
    "url",
    "util",
    "util/types",
    "zlib",
];

fn resolve_common(specifier: &str, referrer: &str) -> Result<ModuleSpecifier, JsErrorBox> {
    let bare_node = NODE_ALLOWED.contains(&specifier)
        && !referrer.starts_with("node:")
        && !referrer.starts_with("ext:");
    let node_name =
        specifier
            .strip_prefix("node:")
            .or(if bare_node { Some(specifier) } else { None });
    if let Some(name) = node_name {
        if referrer.starts_with("node:") || referrer.starts_with("ext:") {
            // Deno's own polyfills importing each other.
            return ModuleSpecifier::parse(&format!("node:{name}")).map_err(JsErrorBox::from_err);
        }
        if !NODE_ALLOWED.contains(&name) {
            return Err(JsErrorBox::generic("node:{name} is not available on Renox"));
        }
        return ModuleSpecifier::parse(&format!("node:{name}")).map_err(JsErrorBox::from_err);
    }
    let base = if referrer.starts_with(VIRTUAL_ROOT) {
        referrer
    } else {
        VIRTUAL_ROOT
    };
    let resolved = deno_core::resolve_import(specifier, base)
        .map_err(|_| JsErrorBox::generic(format!("module specifier not allowed: {specifier}")))?;
    relative_path(&resolved)?;
    Ok(resolved)
}

/// Where the sources come from.
enum Source {
    /// `code.format = "esm-dir"`: files under the canonical `code/` directory.
    Dir(PathBuf),
    /// `code.format = "eszip"`: module sources taken out of `bundle.eszip`
    /// when the isolate is created (specifier -> source).
    Memory(Arc<HashMap<String, Arc<[u8]>>>),
}

/// The loader of one isolate.
pub struct ArtifactLoader {
    source: Source,
}

impl ArtifactLoader {
    pub fn esm_dir(code_dir: &Path) -> Result<ArtifactLoader, JsErrorBox> {
        let canonical = code_dir
            .canonicalize()
            .map_err(|_| JsErrorBox::generic("artifact code directory missing"))?;
        Ok(ArtifactLoader {
            source: Source::Dir(canonical),
        })
    }

    pub fn in_memory(modules: Arc<HashMap<String, Arc<[u8]>>>) -> ArtifactLoader {
        ArtifactLoader {
            source: Source::Memory(modules),
        }
    }

    fn read(&self, specifier: &ModuleSpecifier) -> Result<ModuleSource, JsErrorBox> {
        if specifier.scheme() == "node" {
            return Err(JsErrorBox::generic("unknown node: built-in"));
        }
        let rel = relative_path(specifier)?;
        let module_type = module_type_for(&rel)?;
        let bytes: Vec<u8> = match &self.source {
            Source::Dir(root) => {
                let path = root.join(&rel);
                let canonical = path
                    .canonicalize()
                    .map_err(|_| JsErrorBox::generic(format!("module not found: {specifier}")))?;
                if !canonical.starts_with(root) || !canonical.is_file() {
                    return Err(JsErrorBox::generic("module not found: {specifier}"));
                }
                std::fs::read(&canonical)
                    .map_err(|_| JsErrorBox::generic(format!("module not found: {specifier}")))?
            }
            Source::Memory(map) => map
                .get(specifier.as_str())
                .map(|b| b.to_vec())
                .ok_or_else(|| JsErrorBox::generic(format!("module not found: {specifier}")))?,
        };
        let code = String::from_utf8(bytes)
            .map_err(|_| JsErrorBox::generic(format!("module is not UTF-8: {specifier}")))?;
        Ok(ModuleSource::new(
            module_type,
            ModuleSourceCode::String(code.into()),
            specifier,
            None,
        ))
    }
}

impl ModuleLoader for ArtifactLoader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: ResolutionKind,
    ) -> Result<ModuleSpecifier, JsErrorBox> {
        resolve_common(specifier, referrer)
    }

    fn load(
        &self,
        module_specifier: &ModuleSpecifier,
        _maybe_referrer: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        let requested_module_type = options.requested_module_type;
        let result = self.read(module_specifier).and_then(|src| {
            match (&requested_module_type, &src.module_type) {
                (RequestedModuleType::None, ModuleType::JavaScript)
                | (RequestedModuleType::Json, ModuleType::Json) => Ok(src),
                _ => Err(JsErrorBox::generic(format!(
                    "module type mismatch: {module_specifier}"
                ))),
            }
        });
        ModuleLoadResponse::Sync(result)
    }
}

/// Take every JavaScript and JSON module out of `code/bundle.eszip`
/// (`code.format = "eszip"`), keyed by specifier. Only eszip v2 is accepted.
/// The archive is parsed fully before the isolate starts, so module loading
/// never waits on I/O.
pub async fn eszip_modules(
    artifact: &crate::manifest::Artifact,
) -> Result<Arc<HashMap<String, Arc<[u8]>>>, JsErrorBox> {
    let bytes = std::fs::read(artifact.code_dir().join("bundle.eszip"))
        .map_err(|_| JsErrorBox::generic("bundle.eszip unreadable"))?;
    let (archive, complete) = eszip::Eszip::parse(futures::io::Cursor::new(bytes))
        .await
        .map_err(|e| JsErrorBox::generic(format!("bundle.eszip: {e}")))?;
    complete
        .await
        .map_err(|e| JsErrorBox::generic(format!("bundle.eszip: {e}")))?;
    let eszip::Eszip::V2(v2) = archive else {
        return Err(JsErrorBox::generic(
            "bundle.eszip: only eszip v2 is supported",
        ));
    };
    let mut modules = HashMap::new();
    for specifier in v2.specifiers() {
        let Some(module) = v2.get_module(&specifier) else {
            continue;
        };
        if !matches!(
            module.kind,
            eszip::ModuleKind::JavaScript | eszip::ModuleKind::Json
        ) {
            continue;
        }
        if let Some(source) = module.source().await {
            modules.insert(specifier, source);
        }
    }
    Ok(Arc::new(modules))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_rules() {
        let ok = |s: &str, r: &str| resolve_common(s, r).map(|u| u.to_string());
        assert_eq!(
            ok("./b.js", "file:///functions/a.js").unwrap(),
            "file:///functions/b.js"
        );
        assert_eq!(
            ok("../lib/c.js", "file:///functions/a.js").unwrap(),
            "file:///lib/c.js"
        );
        // `..` above the root is clamped by URL resolution to the virtual root,
        // which is still inside code/.
        assert_eq!(
            ok("../../../etc/passwd", "file:///a.js").unwrap(),
            "file:///etc/passwd"
        );
        for bad in [
            "https://example.com/x.js",
            "data:text/javascript,1",
            "npm:left-pad",
            "jsr:@std/path",
            "file://host/x.js",
            "/x.js?y",
            "./a%5Cb.js",
        ] {
            assert!(ok(bad, "file:///functions/a.js").is_err(), "{bad}");
        }
        assert_eq!(ok("node:path", "file:///a.js").unwrap(), "node:path");
        assert_eq!(ok("buffer", "file:///a.js").unwrap(), "node:buffer");
        for denied in [
            "node:fs",
            "node:process",
            "node:child_process",
            "node:net",
            "node:vm",
            "node:v8",
            "node:perf_hooks",
            "node:worker_threads",
            "node:os",
        ] {
            assert!(ok(denied, "file:///a.js").is_err(), "{denied}");
        }
    }

    #[test]
    fn module_types() {
        assert!(module_type_for("a.js").is_ok());
        assert!(module_type_for("a.json").is_ok());
        assert!(module_type_for("a.ts").is_err());
        assert!(module_type_for("a.wasm").is_err());
    }
}
