//! `manifest.json` and the load-time checks of an artifact directory
//! (`docs/contracts/artifact.md` sections 1-3 and the rules marked *load*
//! in section 6). Pure Rust, no V8.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The newest artifact contract version this runtime understands. Versions
/// 0 and 1 are both accepted (`artifact.md` section 8).
pub const ARTIFACT_VERSION: u32 = 1;

/// V5: bytes under `code/` (20 MiB).
pub const MAX_CODE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Options,
    Head,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
            Method::Options => "OPTIONS",
            Method::Head => "HEAD",
        }
    }

    /// Methods are case-sensitive on the wire (RFC 9110); `get` is not `GET`.
    pub fn parse(s: &str) -> Option<Method> {
        Some(match s {
            "GET" => Method::Get,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "PATCH" => Method::Patch,
            "DELETE" => Method::Delete,
            "OPTIONS" => Method::Options,
            "HEAD" => Method::Head,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Function,
    /// Version 1: a `pages/` route (`artifact.md` section 3, "Page routes").
    Page,
    /// Version 1.3: `functions/ws/**`, the module's `export const ws`
    /// (`ops.md` 1.5.0 section 18).
    Ws,
    /// Version 1.3: `functions/sse/**`, `export const sse`.
    Sse,
    /// Version 1.3: an App MCP tool (`ops.md` 1.5.0 section 19); no path,
    /// reached through `/mcp`. The module default-exports `tool(...)`.
    Tool,
    /// Version 1.3: a scheduled job (`ops.md` section 20); no path. Run by
    /// the F6 scheduler (#297).
    Job,
}

/// The fields of a `tool` route (`artifact.md` 1.3).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolRoute {
    pub name: String,
    pub description: String,
    /// JSON Schema of the input (the keyword subset of the SDK's `tool()`).
    pub input: serde_json::Value,
    pub action: String,
    pub confirm: bool,
}

/// The fields of a `job` route (`artifact.md` 1.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRoute {
    pub name: String,
    pub schedule: String,
    pub tz: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum CodeFormat {
    #[serde(rename = "esm-dir")]
    EsmDir,
    #[serde(rename = "eszip")]
    Eszip,
}

/// One route. Function routes carry `method`, `module`, `export` as in the
/// manifest. A page route answers `GET` (and `HEAD`), so its `method` is
/// `GET`; `module` is the page module or empty for an `.html`-only page,
/// `export` is `load` when the module exports one, otherwise empty, and
/// `page` holds the rest of the page fields.
#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "WireRoute")]
pub struct RouteDef {
    pub kind: RouteKind,
    pub method: Method,
    pub path: String,
    pub module: String,
    pub export: String,
    pub page: Option<PageRoute>,
    /// Artifact 1.3: the module's `export const guard`, as `renox build`
    /// recorded it (`ops.md` 1.5.0 section 17, "`guard`").
    pub guard: Option<crate::ops::authz::Guard>,
    /// A `tool` route's fields.
    pub tool: Option<ToolRoute>,
    /// A `job` route's fields.
    pub job: Option<JobRoute>,
    /// Artifact 1.4: a `webhook` route (`functions/webhooks/*.ts`, `POST`
    /// only; ops.md 1.7.0 section 22): its `provider`, `generic` when absent.
    /// The route is otherwise a function route.
    pub webhook: Option<String>,
}

/// The page fields of a version 1 page route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRoute {
    pub module: Option<String>,
    pub load: bool,
    pub actions: Vec<String>,
    pub template: Option<String>,
}

impl RouteDef {
    /// The page fields, for a page route.
    pub fn page(&self) -> Option<&PageRoute> {
        self.page.as_ref()
    }

    /// The exported function the isolate calls, if any.
    pub fn handler_export(&self) -> Option<&str> {
        (!self.export.is_empty()).then_some(self.export.as_str())
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum WireRoute {
    Function {
        method: Method,
        path: String,
        module: String,
        export: String,
        #[serde(default)]
        guard: Option<crate::ops::authz::Guard>,
    },
    Ws {
        path: String,
        module: String,
        #[serde(default)]
        guard: Option<crate::ops::authz::Guard>,
    },
    Webhook {
        path: String,
        module: String,
        export: String,
        #[serde(default)]
        provider: Option<String>,
    },
    Tool {
        name: String,
        module: String,
        description: String,
        input: serde_json::Value,
        action: String,
        #[serde(default)]
        confirm: bool,
    },
    Job {
        name: String,
        module: String,
        schedule: String,
        #[serde(default)]
        tz: Option<String>,
    },
    Sse {
        path: String,
        module: String,
        #[serde(default)]
        guard: Option<crate::ops::authz::Guard>,
    },
    Page {
        path: String,
        #[serde(default)]
        module: Option<String>,
        #[serde(default)]
        load: bool,
        #[serde(default)]
        actions: Vec<String>,
        #[serde(default)]
        template: Option<String>,
        #[serde(default)]
        guard: Option<crate::ops::authz::Guard>,
    },
}

impl TryFrom<WireRoute> for RouteDef {
    type Error = String;

    fn try_from(w: WireRoute) -> Result<RouteDef, String> {
        Ok(match w {
            WireRoute::Function {
                method,
                path,
                module,
                export,
                guard,
            } => RouteDef {
                kind: RouteKind::Function,
                method,
                path,
                module,
                export,
                page: None,
                guard,
                tool: None,
                job: None,
                webhook: None,
            },
            WireRoute::Webhook {
                path,
                module,
                export,
                provider,
            } => {
                if export != "POST" {
                    return Err(format!("webhook route {path}: export must be POST"));
                }
                RouteDef {
                    kind: RouteKind::Function,
                    method: Method::Post,
                    path,
                    module,
                    export,
                    page: None,
                    guard: None,
                    tool: None,
                    job: None,
                    webhook: Some(provider.unwrap_or_else(|| "generic".into())),
                }
            }
            WireRoute::Ws {
                path,
                module,
                guard,
            } => RouteDef {
                kind: RouteKind::Ws,
                method: Method::Get,
                path,
                module,
                export: "ws".into(),
                page: None,
                guard,
                tool: None,
                job: None,
                webhook: None,
            },
            WireRoute::Sse {
                path,
                module,
                guard,
            } => RouteDef {
                kind: RouteKind::Sse,
                method: Method::Get,
                path,
                module,
                export: "sse".into(),
                page: None,
                guard,
                tool: None,
                job: None,
                webhook: None,
            },
            WireRoute::Tool {
                name,
                module,
                description,
                input,
                action,
                confirm,
            } => RouteDef {
                kind: RouteKind::Tool,
                method: Method::Post,
                path: String::new(),
                module,
                export: "default".into(),
                page: None,
                guard: None,
                tool: Some(ToolRoute {
                    name,
                    description,
                    input,
                    action,
                    confirm,
                }),
                job: None,
                webhook: None,
            },
            WireRoute::Job {
                name,
                module,
                schedule,
                tz,
            } => RouteDef {
                kind: RouteKind::Job,
                method: Method::Post,
                path: String::new(),
                module,
                export: "run".into(),
                page: None,
                guard: None,
                tool: None,
                webhook: None,
                job: Some(JobRoute { name, schedule, tz }),
            },
            WireRoute::Page {
                path,
                module,
                load,
                actions,
                template,
                guard,
            } => RouteDef {
                kind: RouteKind::Page,
                method: Method::Get,
                path,
                module: module.clone().unwrap_or_default(),
                export: if load { "load".into() } else { String::new() },
                page: Some(PageRoute {
                    module,
                    load,
                    actions,
                    template,
                }),
                guard,
                tool: None,
                job: None,
                webhook: None,
            },
        })
    }
}

/// `manifest.templates[id].kind` (version 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateKind {
    Page,
    Layout,
    Partial,
    Error,
    NotFound,
}

/// One fragment of a page's fragment map.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FragmentDef {
    pub target: Option<String>,
}

/// `manifest.templates[id]` (version 1).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateDef {
    pub kind: TemplateKind,
    #[serde(default)]
    pub fragments: Option<BTreeMap<String, FragmentDef>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactInfo {
    pub version: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct App {
    pub name: String,
    pub timezone: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Code {
    pub format: CodeFormat,
    /// Module id -> module path (relative to `code/`, or the `file:///`
    /// specifier inside `bundle.eszip`).
    pub entry: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    pub network: Vec<String>,
    pub secrets: Vec<String>,
}

/// Per-app overrides; the runtime applies `min(override, tier limit)`.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LimitOverrides {
    pub cpu_ms: Option<u64>,
    pub wall_ms: Option<u64>,
    pub memory_mb: Option<u64>,
    pub concurrency: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub artifact: ArtifactInfo,
    pub app: App,
    pub code: Code,
    pub routes: Vec<RouteDef>,
    pub permissions: Permissions,
    #[serde(default)]
    pub limits: Option<LimitOverrides>,
    #[serde(default)]
    /// Artifact 1.1: the installed modules, an array in lock order
    /// (`artifact.md` section 3, "Modules"); versions 0 and 1: `{}`.
    /// Parsed and checked by `ops::modules::ModuleRegistry`.
    pub modules: Option<serde_json::Value>,
    /// Artifact 1.1: slot name -> fillers (rendered by the cell).
    #[serde(default)]
    pub slots: Option<serde_json::Value>,
    /// Version 1: template id -> kind and fragment map.
    #[serde(default)]
    pub templates: Option<BTreeMap<String, TemplateDef>>,
    /// Version 1: the resolved `renox.toml [security]`; applied by the
    /// gateway and the cell, kept opaque here.
    #[serde(default)]
    pub security: Option<serde_json::Value>,
    /// Artifact 1.2: code entry id -> its recorded exports and `eager`
    /// flag (`artifact.md` section 3, "Entries"; ops.md 1.4.0 section 11).
    /// Absent: every entry is eager.
    #[serde(default)]
    pub entries: Option<BTreeMap<String, EntryInfo>>,
    /// Artifact 1.3: the app's resolved `renox.toml [authz]` (`actions`,
    /// `ownership`, `entities`, `default_roles`, `sensitive`); read by the
    /// cell's engine and by `db.scoped()` (`ops.md` 1.5.0 section 17).
    #[serde(default)]
    pub authz: Option<serde_json::Value>,
    /// Artifact 1.3: the app's `renox.toml [realtime]` (`feeds`).
    #[serde(default)]
    pub realtime: Option<serde_json::Value>,
    /// Artifact 1.4: the app's `renox.toml [storage]` (`allowed_types`,
    /// `images.widths`; ops.md 1.7.0 section 21).
    #[serde(default)]
    pub storage: Option<serde_json::Value>,
    /// Artifact 1.4: the app's `renox.toml [ai]` (`mode`; ops.md section 23).
    #[serde(default)]
    pub ai: Option<serde_json::Value>,
    /// Free-text note the schema allows at the top level; ignored (#147).
    #[serde(rename = "$comment", default)]
    pub comment: Option<String>,
}

/// One `entries` record (artifact 1.2).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryInfo {
    /// The module's static export names, as `renox build` recorded them.
    pub exports: Vec<String>,
    /// `false`: evaluated on the first request that needs it. Default true.
    #[serde(default)]
    pub eager: Option<bool>,
}

impl Manifest {
    /// Whether code entry `id` is evaluated at isolate creation (ops.md
    /// 1.4.0 section 11, step 4). A module's `services` and `hooks` entries
    /// are always eager.
    pub fn is_eager(&self, id: &str) -> bool {
        let always =
            id.starts_with("modules/") && (id.ends_with("/services") || id.ends_with("/hooks"));
        always
            || self
                .entries
                .as_ref()
                .and_then(|e| e.get(id))
                .and_then(|e| e.eager)
                .unwrap_or(true)
    }

    /// The templates of a version 1 manifest (empty otherwise).
    pub fn template_defs(&self) -> impl Iterator<Item = (&String, &TemplateDef)> {
        self.templates.iter().flatten()
    }
}

/// An artifact refused at load. `rule` is the contract's `V1`-`V16`. The
/// message names artifact-relative paths only, never a path of the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadError {
    pub rule: &'static str,
    pub reason: String,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.rule, self.reason)
    }
}

impl std::error::Error for LoadError {}

fn load_err(rule: &'static str, reason: impl Into<String>) -> LoadError {
    LoadError {
        rule,
        reason: reason.into(),
    }
}

/// A verified artifact on disk.
#[derive(Debug, Clone)]
pub struct Artifact {
    /// The artifact root (its directory name is `hash`).
    pub root: PathBuf,
    pub hash: String,
    pub manifest: Manifest,
}

impl Artifact {
    /// The directory tenant modules are loaded from.
    pub fn code_dir(&self) -> PathBuf {
        self.root.join("code")
    }
}

/// V1, "Paths": one artifact-relative path.
pub fn check_relative_path(p: &str) -> Result<(), &'static str> {
    if p.is_empty() || p.len() > 512 {
        return Err("empty or longer than 512 bytes");
    }
    if p.starts_with('/') || p.ends_with('/') {
        return Err("leading or trailing /");
    }
    let segments: Vec<&str> = p.split('/').collect();
    if segments.len() > 32 {
        return Err("more than 32 segments");
    }
    for s in &segments {
        if s.is_empty() {
            return Err("empty segment");
        }
        if *s == "." || *s == ".." {
            return Err("segment . or ..");
        }
    }
    if p.chars().any(|c| c == '\\' || c == ':' || c.is_control()) {
        return Err("backslash, colon, or control character");
    }
    Ok(())
}

/// Walk the tree: every regular file with its artifact-relative path.
/// Symbolic links and special files are refused (V1).
fn collect_files(root: &Path) -> Result<Vec<(String, PathBuf)>, LoadError> {
    let mut out = Vec::new();
    let mut stack = vec![(String::new(), root.to_path_buf())];
    while let Some((rel, dir)) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|_| load_err("V1", format!("cannot read directory {rel:?}")))?;
        for entry in entries {
            let entry = entry.map_err(|_| load_err("V1", "cannot read directory entry"))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| load_err("V1", "non UTF-8 file name"))?;
            let rel_path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            // symlink_metadata: never follow a link.
            let meta = entry
                .metadata()
                .map_err(|_| load_err("V1", format!("cannot stat {rel_path:?}")))?;
            let ft = meta.file_type();
            if ft.is_symlink() {
                return Err(load_err("V1", format!("symbolic link {rel_path:?}")));
            } else if ft.is_dir() {
                stack.push((rel_path, entry.path()));
            } else if ft.is_file() {
                check_relative_path(&rel_path)
                    .map_err(|r| load_err("V1", format!("{rel_path:?}: {r}")))?;
                out.push((rel_path, entry.path()));
            } else {
                return Err(load_err("V1", format!("special file {rel_path:?}")));
            }
        }
    }
    Ok(out)
}

/// V2: the content hash of section 2 (canonical `sha256sum` listing).
pub fn content_hash(root: &Path) -> Result<String, LoadError> {
    let mut files = collect_files(root)?;
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut listing = Sha256::new();
    for (rel, path) in &files {
        let bytes = fs::read(path).map_err(|_| load_err("V2", format!("cannot read {rel:?}")))?;
        let digest = hex(&Sha256::digest(&bytes));
        listing.update(format!("{digest}  {rel}\n").as_bytes());
    }
    Ok(hex(&listing.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Load and verify an artifact directory: V1 (paths, links), V2 (hash =
/// directory name), V3 (manifest and version), V5 (code size), V6 (code
/// layout), V7 (routes and entries). V8 (route conflicts) and V9-V12 are
/// `renox check`'s job in F1; the router still refuses invalid patterns.
pub fn load_artifact(root: &Path) -> Result<Artifact, LoadError> {
    let dir_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let files = collect_files(root)?;
    let hash = content_hash(root)?;
    if hash != dir_name {
        return Err(load_err(
            "V2",
            "directory name does not equal the content hash",
        ));
    }
    let raw = fs::read(root.join("manifest.json"))
        .map_err(|_| load_err("V3", "manifest.json missing"))?;
    let manifest: Manifest =
        serde_json::from_slice(&raw).map_err(|e| load_err("V3", format!("manifest.json: {e}")))?;
    let version = manifest.artifact.version;
    if version > ARTIFACT_VERSION {
        return Err(load_err(
            "V3",
            format!("unknown artifact.version {version}"),
        ));
    }
    if version == 0
        && (manifest.templates.is_some()
            || manifest.security.is_some()
            || manifest.routes.iter().any(|r| r.kind == RouteKind::Page))
    {
        return Err(load_err(
            "V3",
            "templates, security, and page routes need artifact.version 1",
        ));
    }
    for (rel, _) in &files {
        let top = rel.split('/').next().unwrap_or("");
        let allowed = match top {
            "manifest.json" | "code" | "migrations" | "public" => true,
            "templates" | "public.json" => version >= 1,
            // Artifact 1.3: the app's own policies and schema (V24).
            "policies"
                if version >= 1
                    && (rel.starts_with("policies/app/")
                        || rel == "policies/schema.cedarschema") =>
            {
                true
            }
            // Artifact 1.1 (`artifact.md` section 1): only with installed modules.
            "policies" | "overrides" | "overrides.json" => {
                version >= 1
                    && manifest
                        .modules
                        .as_ref()
                        .is_some_and(|m| m.as_array().is_some_and(|a| !a.is_empty()))
            }
            _ => false,
        };
        if !allowed {
            return Err(load_err(
                "V1",
                format!("unexpected top-level entry {top:?}"),
            ));
        }
    }
    check_templates(&manifest, &files)?;
    let code_files: Vec<&(String, PathBuf)> = files
        .iter()
        .filter(|(r, _)| r.starts_with("code/"))
        .collect();
    let mut code_bytes = 0u64;
    for (_, p) in &code_files {
        code_bytes += fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    if code_bytes > MAX_CODE_BYTES {
        return Err(load_err(
            "V5",
            format!("code/ is {code_bytes} bytes, over {MAX_CODE_BYTES}"),
        ));
    }
    match manifest.code.format {
        CodeFormat::EsmDir => {
            for (rel, _) in &code_files {
                if !(rel.ends_with(".js") || rel.ends_with(".mjs") || rel.ends_with(".json")) {
                    return Err(load_err(
                        "V6",
                        format!("{rel:?} is not .js, .mjs, or .json"),
                    ));
                }
            }
            for (id, path) in &manifest.code.entry {
                check_relative_path(path)
                    .map_err(|r| load_err("V6", format!("code.entry {id:?}: {r}")))?;
                if !code_files
                    .iter()
                    .any(|(r, _)| r.strip_prefix("code/") == Some(path.as_str()))
                {
                    return Err(load_err(
                        "V6",
                        format!("code.entry {id:?} points to a missing file"),
                    ));
                }
            }
        }
        CodeFormat::Eszip => {
            if code_files.len() != 1 || code_files[0].0 != "code/bundle.eszip" {
                return Err(load_err("V6", "code/ must hold exactly bundle.eszip"));
            }
        }
    }
    for (id, path) in &manifest.code.entry {
        if !(path.ends_with(".js") || path.ends_with(".mjs")) {
            return Err(load_err(
                "V6",
                format!("code.entry {id:?} must end in .js or .mjs"),
            ));
        }
    }
    if manifest.routes.is_empty() || manifest.code.entry.is_empty() {
        return Err(load_err(
            "V7",
            "at least one route and one code.entry are required",
        ));
    }
    for r in &manifest.routes {
        if r.kind == RouteKind::Page {
            check_page_route(&manifest, r)?;
            continue;
        }
        if !manifest.code.entry.contains_key(&r.module) {
            return Err(load_err(
                "V7",
                format!(
                    "route {} {} names unknown module {:?}",
                    r.method.as_str(),
                    r.path,
                    r.module
                ),
            ));
        }
        // A `ws` / `sse` route's handler is its `ws` / `sse` export
        // (artifact.md 1.3, V23).
        if matches!(r.kind, RouteKind::Function) && r.export != r.method.as_str() {
            return Err(load_err(
                "V7",
                format!(
                    "route {} {}: export must equal method",
                    r.method.as_str(),
                    r.path
                ),
            ));
        }
    }
    // Artifact 1.1 (V7 extended): `modules/<name>/services` and
    // `modules/<name>/hooks` are used by the broker, not by a route.
    let broker_entry = |id: &str| {
        id.strip_prefix("modules/")
            .and_then(|r| r.split_once('/'))
            .is_some_and(|(_, part)| part == "services" || part == "hooks")
    };
    for id in manifest.code.entry.keys() {
        if !broker_entry(id)
            && !manifest
                .routes
                .iter()
                .any(|r| !r.module.is_empty() && &r.module == id)
        {
            return Err(load_err(
                "V7",
                format!("code.entry {id:?} is not used by any route"),
            ));
        }
    }
    Ok(Artifact {
        root: root.to_path_buf(),
        hash,
        manifest,
    })
}

/// V14: `templates/` holds exactly `templates/<id>.jinja` for the keys of
/// `manifest.templates`, and each kind matches its id.
fn check_templates(manifest: &Manifest, files: &[(String, PathBuf)]) -> Result<(), LoadError> {
    let on_disk: Vec<&str> = files
        .iter()
        .filter_map(|(r, _)| r.strip_prefix("templates/"))
        .collect();
    for path in &on_disk {
        let known = path
            .strip_suffix(".jinja")
            .is_some_and(|id| manifest.template_defs().any(|(k, _)| k == id));
        if !known {
            return Err(load_err(
                "V14",
                format!("templates/{path} is not in manifest.templates"),
            ));
        }
    }
    for (id, def) in manifest.template_defs() {
        if !on_disk.contains(&format!("{id}.jinja").as_str()) {
            return Err(load_err(
                "V14",
                format!("template {id:?} has no file templates/{id}.jinja"),
            ));
        }
        // artifact.md 1.1: a module's template ids are the app's rules
        // under `modules/<name>/` (V14), for a listed module only (V18).
        let id = match id.strip_prefix("modules/").and_then(|r| r.split_once('/')) {
            Some((m, rest)) => {
                let listed = manifest
                    .modules
                    .as_ref()
                    .and_then(|v| v.as_array())
                    .is_some_and(|a| {
                        a.iter()
                            .any(|e| e.get("name").and_then(|n| n.as_str()) == Some(m))
                    });
                if !listed {
                    return Err(load_err(
                        "V18",
                        format!("template {id:?} belongs to module {m:?}, which is not installed"),
                    ));
                }
                rest
            }
            None => id.as_str(),
        };
        let last = id.rsplit('/').next().unwrap_or("");
        let expected = if id.starts_with("partials/") {
            Some(TemplateKind::Partial)
        } else if id.starts_with("pages/_layouts/") {
            Some(TemplateKind::Layout)
        } else if id == "pages/_error" {
            Some(TemplateKind::Error)
        } else if id == "pages/_404" {
            Some(TemplateKind::NotFound)
        } else if id.starts_with("pages/") && !last.starts_with('_') {
            Some(TemplateKind::Page)
        } else {
            None
        };
        if expected != Some(def.kind) {
            return Err(load_err(
                "V14",
                format!("template {id:?} cannot have kind {:?}", def.kind),
            ));
        }
        if (def.kind == TemplateKind::Page) != def.fragments.is_some() {
            return Err(load_err(
                "V14",
                format!("template {id:?}: fragments are required for pages only"),
            ));
        }
    }
    Ok(())
}

/// V7 and V15 for one page route.
fn check_page_route(manifest: &Manifest, r: &RouteDef) -> Result<(), LoadError> {
    let page = r.page().expect("page route");
    let name = format!("page {}", r.path);
    if let Some(module) = &page.module {
        // artifact.md 1.1: a module's page code is `modules/<name>/pages/...`.
        let bare = module
            .strip_prefix("modules/")
            .and_then(|r| r.split_once('/'))
            .map_or(module.as_str(), |(_, rest)| rest);
        if !bare.starts_with("pages/") || !manifest.code.entry.contains_key(module) {
            return Err(load_err(
                "V7",
                format!("{name} names unknown page module {module:?}"),
            ));
        }
    } else if page.load || !page.actions.is_empty() {
        return Err(load_err(
            "V15",
            format!("{name}: load and actions need a module"),
        ));
    }
    match (&page.module, page.load, &page.template) {
        (None, _, None) => {
            return Err(load_err(
                "V15",
                format!("{name}: no module and no template"),
            ));
        }
        (Some(_), false, None) => {
            return Err(load_err(
                "V15",
                format!("{name}: a page without a template must export load"),
            ));
        }
        _ => {}
    }
    if let Some(t) = &page.template {
        let ok = manifest
            .template_defs()
            .any(|(id, d)| id == t && d.kind == TemplateKind::Page);
        if !ok {
            return Err(load_err(
                "V15",
                format!("{name}: template {t:?} is not a page template"),
            ));
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    if !page.actions.iter().all(|a| seen.insert(a)) {
        return Err(load_err("V15", format!("{name}: duplicate action names")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts/examples/hello-artifact/802957869194e4c16e462dfcb50bfa6b3e435fca606b96a1223e2b7e21271d7a")
    }

    #[test]
    fn hello_artifact_loads_and_hash_matches() {
        let a = load_artifact(&hello_dir()).unwrap();
        assert_eq!(a.manifest.routes.len(), 1);
        assert_eq!(a.manifest.code.format, CodeFormat::EsmDir);
    }

    /// Artifact version 1 (#152): the contract's worked example loads, with
    /// page routes, templates (V14) and `security`.
    #[test]
    fn shop_v1_artifact_loads() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts/examples/artifact/shop-artifact/3597f77a2b9c91728657e3c2b8d45d8e3c05b3eed075edf02d328bbc90e62f64");
        let a = load_artifact(&dir).unwrap();
        assert_eq!(a.manifest.artifact.version, 1);
        let product = &a.manifest.routes[1];
        assert_eq!(product.kind, RouteKind::Page);
        assert_eq!(product.handler_export(), Some("load"));
        assert_eq!(a.manifest.routes[0].handler_export(), None);
        assert_eq!(a.manifest.template_defs().count(), 6);
    }

    /// V3: version 1 fields in a version 0 manifest are refused.
    #[test]
    fn version_0_refuses_page_routes() {
        let tmp = std::env::temp_dir().join(format!("renox-manifest-v0-{}", std::process::id()));
        let src = tmp.join("src");
        fs::create_dir_all(src.join("code")).unwrap();
        fs::write(src.join("code/x.js"), "export function load() {}").unwrap();
        let manifest = serde_json::json!({
            "artifact": { "version": 0 },
            "app": { "name": "x", "timezone": "UTC" },
            "code": { "format": "esm-dir", "entry": { "pages/x": "x.js" } },
            "routes": [{ "kind": "page", "path": "/", "module": "pages/x", "load": true }],
            "permissions": { "network": [], "secrets": [] }
        });
        fs::write(src.join("manifest.json"), manifest.to_string()).unwrap();
        let hash = content_hash(&src).unwrap();
        let dir = tmp.join(&hash);
        fs::rename(&src, &dir).unwrap();
        let err = load_artifact(&dir).unwrap_err();
        assert_eq!(err.rule, "V3", "{err}");
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn relative_paths() {
        for bad in [
            "", "/a", "a/", "a//b", "a/../b", "./a", "a\\b", "a:b", "a\u{1}b",
        ] {
            assert!(check_relative_path(bad).is_err(), "{bad:?}");
        }
        assert!(check_relative_path("functions/api/hello.js").is_ok());
    }

    /// #147: `manifest.schema.json` allows a top-level `$comment`; the
    /// runtime accepts and ignores it, and still refuses other unknown keys.
    #[test]
    fn top_level_comment_is_accepted() {
        let mut v: serde_json::Value =
            serde_json::from_slice(&fs::read(hello_dir().join("manifest.json")).unwrap()).unwrap();
        v["$comment"] = serde_json::json!("built by hand");
        let m: Manifest = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(m.comment.as_deref(), Some("built by hand"));
        v["comment"] = serde_json::json!("not in the schema");
        assert!(serde_json::from_value::<Manifest>(v).is_err());
    }

    #[test]
    fn hash_mismatch_is_refused() {
        let tmp = std::env::temp_dir().join(format!("renox-manifest-test-{}", std::process::id()));
        let dir = tmp.join("0000000000000000000000000000000000000000000000000000000000000000");
        fs::create_dir_all(dir.join("code")).unwrap();
        fs::copy(hello_dir().join("manifest.json"), dir.join("manifest.json")).unwrap();
        let err = load_artifact(&dir).unwrap_err();
        assert_eq!(err.rule, "V2");
        fs::remove_dir_all(&tmp).unwrap();
    }
}
