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
//!
//! V8 code cache (#157): the code V8 compiles for a module is kept in
//! [`CodeCache`] (process-wide, in memory) and handed back when another
//! isolate of the same tenant and deployment loads the same module: pool
//! members, the spare, and re-creation after a recycle or an idle eviction
//! skip compiling the module's eagerly compiled functions. A deployment's
//! first isolate stores nothing: only a deployment created a second time
//! gets entries, so the many tenants that only ever run one isolate (B1,
//! B2) pay no memory for it (a `shop` deployment's cache is about 270 KB).
//! Entries are
//! scoped by tenant and deployment, so no tenant ever consumes code
//! compiled from another tenant's source, and keyed by a hash of the full
//! source text: V8 itself only checks the source length.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use deno_core::{
    ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader, ModuleSource,
    ModuleSourceCode, ModuleSpecifier, ModuleType, RequestedModuleType, ResolutionKind,
    SourceCodeCacheInfo,
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

/// `renox:modules` (ops.md 1.3.0 section 15.2): a virtual module with one
/// export per installed module, the broker's service proxies.
pub const RENOX_MODULES: &str = "renox:modules";

fn resolve_common(specifier: &str, referrer: &str) -> Result<ModuleSpecifier, JsErrorBox> {
    if specifier == RENOX_MODULES {
        return ModuleSpecifier::parse(RENOX_MODULES).map_err(JsErrorBox::from_err);
    }
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
    /// `<tenant>/<deployment>` when the code cache is used.
    cache_scope: Option<String>,
    /// Store what V8 compiles (not on a deployment's first isolate).
    cache_store: bool,
    /// Installed module names, the exports of `renox:modules`.
    modules: Vec<String>,
}

/// Upper bound of [`CodeCache`]: an entry that would go over it empties
/// the cache first, so entries of old deployments do not stay forever.
pub const CODE_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Deployments remembered as created once; the set is emptied when full.
const SEEN_MAX: usize = 100_000;

/// Compiled code per (tenant, deployment, module), see the module docs.
pub struct CodeCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
    /// Scopes that already created an isolate (bounded like the entries).
    seen: Mutex<HashSet<String>>,
    bytes: AtomicUsize,
    enabled: AtomicBool,
    hits: AtomicU64,
    stores: AtomicU64,
}

struct CacheEntry {
    source_hash: u64,
    data: Arc<[u8]>,
}

/// The process's code cache.
pub fn code_cache() -> &'static CodeCache {
    static CACHE: LazyLock<CodeCache> = LazyLock::new(|| CodeCache {
        entries: Mutex::new(HashMap::new()),
        seen: Mutex::new(HashSet::new()),
        bytes: AtomicUsize::new(0),
        enabled: AtomicBool::new(true),
        hits: AtomicU64::new(0),
        stores: AtomicU64::new(0),
    });
    &CACHE
}

fn cache_key(scope: &str, specifier: &str) -> String {
    format!("{scope}\n{specifier}")
}

fn source_hash(code: &str) -> u64 {
    let mut h = std::hash::DefaultHasher::new();
    code.hash(&mut h);
    h.finish()
}

impl CodeCache {
    /// Turn the cache on or off for isolates created from now on (on by
    /// default; off for the B1/B4 comparison).
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Modules served from the cache so far (V8 may still reject one).
    pub fn hits(&self) -> u64 {
        self.hits.load(Ordering::SeqCst)
    }

    /// Caches V8 produced and the cache stored (a module compiled without a
    /// cache, or whose cache V8 rejected).
    pub fn stores(&self) -> u64 {
        self.stores.load(Ordering::SeqCst)
    }

    /// Bytes held.
    pub fn bytes(&self) -> usize {
        self.bytes.load(Ordering::SeqCst)
    }

    /// Entries of one `<tenant>/<deployment>` scope.
    pub fn entries_for(&self, scope: &str) -> usize {
        let prefix = format!("{scope}\n");
        self.entries
            .lock()
            .expect("code cache lock")
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .count()
    }

    /// Drop every entry of a `<tenant>/<deployment>` scope.
    pub fn forget(&self, scope: &str) {
        let prefix = format!("{scope}\n");
        let mut entries = self.entries.lock().expect("code cache lock");
        entries.retain(|k, e| {
            let keep = !k.starts_with(&prefix);
            if !keep {
                self.bytes.fetch_sub(e.data.len(), Ordering::SeqCst);
            }
            keep
        });
    }

    fn lookup(&self, scope: &str, specifier: &str, code: &str) -> SourceCodeCacheInfo {
        let hash = source_hash(code);
        let data = self
            .entries
            .lock()
            .expect("code cache lock")
            .get(&cache_key(scope, specifier))
            .filter(|e| e.source_hash == hash)
            .map(|e| e.data.clone());
        if data.is_some() {
            self.hits.fetch_add(1, Ordering::SeqCst);
        }
        SourceCodeCacheInfo {
            hash,
            data: data.map(|d| std::borrow::Cow::Owned(d.to_vec())),
        }
    }

    fn store(&self, scope: &str, specifier: &str, source_hash: u64, data: &[u8]) {
        let mut entries = self.entries.lock().expect("code cache lock");
        let key = cache_key(scope, specifier);
        if data.len() > CODE_CACHE_MAX_BYTES {
            return;
        }
        if let Some(old) = entries.remove(&key) {
            self.bytes.fetch_sub(old.data.len(), Ordering::SeqCst);
        }
        if self.bytes.load(Ordering::SeqCst) + data.len() > CODE_CACHE_MAX_BYTES {
            // Full: start over rather than keep stale deployments forever.
            entries.clear();
            self.bytes.store(0, Ordering::SeqCst);
        }
        self.bytes.fetch_add(data.len(), Ordering::SeqCst);
        entries.insert(
            key,
            CacheEntry {
                source_hash,
                data: data.into(),
            },
        );
        self.stores.fetch_add(1, Ordering::SeqCst);
    }

    /// `true` when `scope` created an isolate before (and remember it).
    fn seen_before(&self, scope: &str) -> bool {
        let mut seen = self.seen.lock().expect("code cache lock");
        if seen.contains(scope) {
            return true;
        }
        if seen.len() >= SEEN_MAX {
            seen.clear();
        }
        seen.insert(scope.to_string());
        false
    }

    fn purge(&self, scope: &str, specifier: &str) {
        let mut entries = self.entries.lock().expect("code cache lock");
        if let Some(e) = entries.remove(&cache_key(scope, specifier)) {
            self.bytes.fetch_sub(e.data.len(), Ordering::SeqCst);
        }
    }
}

impl ArtifactLoader {
    pub fn esm_dir(code_dir: &Path) -> Result<ArtifactLoader, JsErrorBox> {
        let canonical = code_dir
            .canonicalize()
            .map_err(|_| JsErrorBox::generic("artifact code directory missing"))?;
        Ok(ArtifactLoader {
            source: Source::Dir(canonical),
            cache_scope: None,
            cache_store: false,
            modules: Vec::new(),
        })
    }

    pub fn in_memory(modules: Arc<HashMap<String, Arc<[u8]>>>) -> ArtifactLoader {
        ArtifactLoader {
            source: Source::Memory(modules),
            cache_scope: None,
            cache_store: false,
            modules: Vec::new(),
        }
    }

    /// Use the process's [`CodeCache`] under `<tenant_id>/<deployment_hash>`,
    /// if it is enabled, from the deployment's
    /// second isolate on.
    pub fn with_code_cache(mut self, tenant_id: &str, deployment_hash: &str) -> ArtifactLoader {
        let cache = code_cache();
        if cache.enabled() {
            let scope = format!("{tenant_id}/{deployment_hash}");
            self.cache_store = cache.seen_before(&scope);
            self.cache_scope = Some(scope);
        }
        self
    }

    /// The installed modules, for `renox:modules` (in the artifact's order).
    pub fn with_modules(mut self, names: Vec<String>) -> ArtifactLoader {
        self.modules = names;
        self
    }

    /// Whether the artifact holds `specifier` (ops.md 1.4.0 section 11,
    /// step 4: every entry is checked at isolate creation, lazy ones too).
    pub fn has(&self, specifier: &ModuleSpecifier) -> bool {
        let Ok(rel) = relative_path(specifier) else {
            return false;
        };
        match &self.source {
            Source::Dir(root) => root
                .join(&rel)
                .canonicalize()
                .is_ok_and(|c| c.starts_with(root) && c.is_file()),
            Source::Memory(map) => map.contains_key(specifier.as_str()),
        }
    }

    fn read(&self, specifier: &ModuleSpecifier) -> Result<ModuleSource, JsErrorBox> {
        if specifier.scheme() == "node" {
            return Err(JsErrorBox::generic("unknown node: built-in"));
        }
        if specifier.as_str() == RENOX_MODULES {
            // The proxies were frozen onto a non-writable global by the
            // bootstrap's harden(); the caller of each call is the module
            // whose code runs (the async context), not the importer.
            let mut code = String::from("const m = globalThis.__renoxModules;\n");
            for name in &self.modules {
                code.push_str(&format!("export const {name} = m[{name:?}];\n"));
            }
            return Ok(ModuleSource::new(
                ModuleType::JavaScript,
                ModuleSourceCode::String(code.into()),
                specifier,
                None,
            ));
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
        // No cache info at all on a deployment's first isolate: with any,
        // V8 would also serialise a cache for the loader to drop.
        let cache = match (&self.cache_scope, &module_type) {
            (Some(scope), ModuleType::JavaScript) if self.cache_store => {
                Some(code_cache().lookup(scope, specifier.as_str(), &code))
            }
            _ => None,
        };
        Ok(ModuleSource::new(
            module_type,
            ModuleSourceCode::String(code.into()),
            specifier,
            cache,
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

    fn code_cache_ready(
        &self,
        module_specifier: ModuleSpecifier,
        hash: u64,
        code_cache: &[u8],
    ) -> Pin<Box<dyn std::future::Future<Output = ()>>> {
        if let (Some(scope), true) = (&self.cache_scope, self.cache_store) {
            self::code_cache().store(scope, module_specifier.as_str(), hash, code_cache);
        }
        Box::pin(async {})
    }

    fn purge_and_prevent_code_cache(&self, module_specifier: &str) {
        if let Some(scope) = &self.cache_scope {
            code_cache().purge(scope, module_specifier);
        }
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
