//! The deploy-time compiler (`docs/08-template-engine.md`, "Compile
//! pipeline"): parse with html5ever, resolve layouts, components, slots,
//! and module overrides, validate, emit minijinja source, record the
//! fragment map.
//!
//! Input is a [`TemplateProject`]: the app's template files by their
//! app-relative path.
//!
//! | Path | Becomes |
//! | --- | --- |
//! | `pages/**/*.html` | template id `pages/...` (page, `_layouts/*` layout, `_error`, `_404`) |
//! | `partials/<name>.html` | template id `partials/<name>`, and the component `<x-<name>>` |
//! | `modules/<m>/(pages\|partials)/**/*.html` | template id `modules/<m>/...` (artifact 1.1; its kind follows from the id without the prefix), and for partials the namespaced component `<m:<name>>` |
//! | `overrides/<m>/(pages\|partials)/**/*.html` | compiled instead of `modules/<m>/...` into that module's id (`artifact.md` 1.1, "Overrides") |
//!
//! A module template's `<r-layout use="x">` finds the module's own
//! `modules/<m>/pages/_layouts/x` first, then the app's `pages/_layouts/x`.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::rc::Rc;

use minijinja::Environment;

use crate::{CompiledTemplate, CompiledTemplates, Diagnostic, Fragment, TemplateKind};

pub mod attrs;
pub mod expr;
pub mod parse;
mod walker;

use expr::ExprChecker;
use parse::Document;
use walker::{Emitter, Mode};

/// Maximum nesting of components inside components.
pub const MAX_COMPONENT_DEPTH: usize = 16;

/// Template files of one app, by app-relative path (`pages/index.html`).
#[derive(Debug, Clone, Default)]
pub struct TemplateProject {
    files: BTreeMap<String, String>,
}

impl TemplateProject {
    pub fn new() -> TemplateProject {
        TemplateProject::default()
    }

    /// Adds or replaces one file.
    pub fn insert(&mut self, path: impl Into<String>, source: impl Into<String>) {
        self.files.insert(path.into(), source.into());
    }

    pub fn files(&self) -> impl Iterator<Item = (&str, &str)> {
        self.files.iter().map(|(p, s)| (p.as_str(), s.as_str()))
    }

    fn get(&self, path: &str) -> Option<&str> {
        self.files.get(path).map(String::as_str)
    }

    /// Reads every `.html` file under `pages/`, `partials/`, `modules/`, and
    /// `overrides/` of an app directory.
    pub fn from_dir(root: &Path) -> std::io::Result<TemplateProject> {
        let mut project = TemplateProject::new();
        for top in ["pages", "partials", "modules", "overrides"] {
            let dir = root.join(top);
            if dir.is_dir() {
                read_html(&dir, top, &mut project)?;
            }
        }
        Ok(project)
    }
}

fn read_html(dir: &Path, rel: &str, project: &mut TemplateProject) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = format!("{rel}/{name}");
        let ft = entry.file_type()?;
        if ft.is_dir() {
            read_html(&entry.path(), &path, project)?;
        } else if ft.is_file() && name.ends_with(".html") {
            project.insert(path, std::fs::read_to_string(entry.path())?);
        }
    }
    Ok(())
}

/// One filler of a slot (`artifact.md` 1.1, "Slots"): a partial, and the
/// action a user needs to see it. Deserialises from a bare template id too.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(from = "FillerForm")]
pub struct SlotFiller {
    pub template: String,
    /// Rendered only when `can(requires)` holds for the request (`r-can`'s
    /// check); `None` always renders.
    pub requires: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum FillerForm {
    Id(String),
    Full {
        template: String,
        #[serde(default)]
        requires: Option<String>,
    },
}

impl From<FillerForm> for SlotFiller {
    fn from(f: FillerForm) -> SlotFiller {
        match f {
            FillerForm::Id(template) => SlotFiller::from(template),
            FillerForm::Full { template, requires } => SlotFiller { template, requires },
        }
    }
}

impl From<String> for SlotFiller {
    fn from(template: String) -> SlotFiller {
        SlotFiller {
            template,
            requires: None,
        }
    }
}

impl From<&str> for SlotFiller {
    fn from(template: &str) -> SlotFiller {
        SlotFiller::from(template.to_string())
    }
}

/// What the compiler knows beyond the template files.
#[derive(Debug, Clone, Default)]
pub struct CompileOptions {
    /// Cross-module slot registry: slot name -> the partials that fill it,
    /// in order (`<r-slot name="admin.sidebar" />`).
    pub slots: BTreeMap<String, Vec<SlotFiller>>,
    /// The permission actions `r-can` may name. `None` skips the check
    /// (no policy set yet, F5).
    pub actions: Option<BTreeSet<String>>,
    /// Module filters declared in module manifests, on top of the platform
    /// filters.
    pub filters: BTreeSet<String>,
}

/// The template compiler.
#[derive(Debug, Clone, Default)]
pub struct Compiler {
    pub options: CompileOptions,
}

/// A parsed component (`partials/*.html` used as `<x-*>`).
pub(crate) struct Component {
    pub path: String,
    pub doc: Rc<Document>,
    pub props: Vec<Prop>,
    /// Whether the file declares `<r-props>` (then undeclared variables are
    /// errors).
    pub declares_props: bool,
    pub slots: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PropType {
    Bool,
    String,
    Number,
    /// A named type from the app (`Product`): any value.
    Any(String),
}

#[derive(Debug, Clone)]
pub(crate) struct Prop {
    pub name: String,
    pub ty: PropType,
    /// Translated default expression; `None` = required.
    pub default: Option<String>,
}

/// Shared state of one compile run.
pub(crate) struct CompileCx<'p> {
    pub project: &'p TemplateProject,
    pub options: &'p CompileOptions,
    pub checker: ExprChecker,
    docs: RefCell<HashMap<String, Rc<Document>>>,
    components: RefCell<HashMap<String, Rc<Component>>>,
    /// Component paths whose own diagnostics were already produced.
    pub checked_components: RefCell<BTreeSet<String>>,
    /// Layout id -> (slot names, fragments with targets).
    pub layouts: RefCell<BTreeMap<String, LayoutInfo>>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct LayoutInfo {
    pub slots: Vec<String>,
    pub fragments: BTreeMap<String, Fragment>,
}

impl CompileCx<'_> {
    pub fn doc(&self, path: &str) -> Option<Rc<Document>> {
        if let Some(d) = self.docs.borrow().get(path) {
            return Some(d.clone());
        }
        let source = self.project.get(path)?;
        let doc = Rc::new(parse::parse(source));
        self.docs.borrow_mut().insert(path.to_string(), doc.clone());
        Some(doc)
    }

    /// Resolves a component tag to its file: `x-card` -> `partials/card.html`,
    /// `billing:plan-badge` -> the override or `modules/billing/partials/plan-badge.html`.
    pub fn component_path(&self, tag: &str) -> Option<String> {
        if let Some(name) = tag.strip_prefix("x-") {
            let path = format!("partials/{name}.html");
            return self.project.get(&path).map(|_| path);
        }
        let (module, name) = tag.split_once(':')?;
        let over = format!("overrides/{module}/partials/{name}.html");
        if self.project.get(&over).is_some() {
            return Some(over);
        }
        let path = format!("modules/{module}/partials/{name}.html");
        self.project.get(&path).map(|_| path)
    }

    pub fn component(&self, path: &str, diags: &mut Vec<Diagnostic>) -> Option<Rc<Component>> {
        if let Some(c) = self.components.borrow().get(path) {
            return Some(c.clone());
        }
        let doc = self.doc(path)?;
        let c = Rc::new(walker::read_component(self, path, doc, diags));
        self.components
            .borrow_mut()
            .insert(path.to_string(), c.clone());
        Some(c)
    }
}

fn diag(file: &str, message: impl Into<String>) -> Diagnostic {
    Diagnostic {
        file: file.to_string(),
        line: 1,
        col: 1,
        message: message.into(),
    }
}

/// `modules/<m>/<rest>` -> `(m, rest)`.
pub(crate) fn module_of(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix("modules/")?;
    let (m, rest) = rest.split_once('/')?;
    let valid = !m.is_empty()
        && m.len() <= 32
        && m.starts_with(|c: char| c.is_ascii_lowercase())
        && m.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    valid.then_some((m, rest))
}

/// `^(modules/<m>/)?(pages|partials)(/[A-Za-z0-9_.\[\]-]+)+$` (`artifact.md`, "Templates").
fn is_template_id(id: &str) -> bool {
    let id = module_of(id).map_or(id, |(_, rest)| rest);
    let mut segs = id.split('/');
    matches!(segs.next(), Some("pages" | "partials"))
        && id.contains('/')
        && segs.all(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '[' | ']' | '-'))
        })
}

impl Compiler {
    pub fn new(options: CompileOptions) -> Compiler {
        Compiler { options }
    }

    /// Compiles every template of the project. On failure returns all
    /// diagnostics, sorted by file and position.
    pub fn compile(&self, project: &TemplateProject) -> Result<CompiledTemplates, Vec<Diagnostic>> {
        let mut diags = Vec::new();
        let mut ids = BTreeMap::new();
        // Template id -> the file it is compiled from (an override for a
        // module template the tenant overrides).
        let mut files: BTreeMap<String, String> = BTreeMap::new();
        for (path, _) in project.files() {
            let Some(id) = path.strip_suffix(".html") else {
                diags.push(diag(
                    path,
                    "not a template path (pages/, partials/, modules/, overrides/)",
                ));
                continue;
            };
            let (id, file) = if let Some(rest) = id.strip_prefix("overrides/") {
                let original = format!("modules/{rest}");
                if project.get(&format!("{original}.html")).is_none() {
                    diags.push(diag(
                        path,
                        format!("overrides `{original}.html`, which does not exist"),
                    ));
                    continue;
                }
                (original, path.to_string())
            } else {
                if project
                    .get(&format!(
                        "overrides/{}",
                        path.strip_prefix("modules/").unwrap_or("")
                    ))
                    .is_some()
                {
                    // The override is compiled into this id instead.
                    continue;
                }
                (id.to_string(), path.to_string())
            };
            let bare = module_of(&id).map_or(id.as_str(), |(_, rest)| rest);
            if !(bare.starts_with("pages/") || bare.starts_with("partials/")) {
                diags.push(diag(
                    path,
                    "not a template path (pages/, partials/, modules/<m>/pages|partials/, overrides/)",
                ));
                continue;
            }
            if !is_template_id(&id) {
                diags.push(diag(path, format!("`{id}` is not a valid template id")));
                continue;
            }
            match TemplateKind::of_id(&id) {
                Some(kind) => {
                    ids.insert(id.clone(), kind);
                    files.insert(id, file);
                }
                None => diags.push(diag(
                    path,
                    "files under pages/ starting with `_` are not routes: only _layouts/, _error.html and _404.html are known",
                )),
            }
        }
        for (name, providers) in &self.options.slots {
            for SlotFiller { template: id, .. } in providers {
                if ids.get(id) != Some(&TemplateKind::Partial) {
                    diags.push(diag(
                        &format!("{id}.html"),
                        format!("slot `{name}` names provider `{id}`, which is not a partial"),
                    ));
                }
            }
        }

        let cx = CompileCx {
            project,
            options: &self.options,
            checker: ExprChecker::new(&self.options.filters),
            docs: RefCell::default(),
            components: RefCell::default(),
            checked_components: RefCell::default(),
            layouts: RefCell::default(),
        };

        let mut out = CompiledTemplates::default();
        // Layouts first: pages need their slots and fragments.
        let order = ids
            .iter()
            .filter(|(_, k)| **k == TemplateKind::Layout)
            .chain(ids.iter().filter(|(_, k)| **k != TemplateKind::Layout));
        for (id, kind) in order {
            let file = files[id].clone();
            let doc = cx.doc(&file).expect("listed file exists");
            let mode = if *kind == TemplateKind::Layout {
                Mode::Layout
            } else {
                Mode::Template
            };
            let mut em = Emitter::new(&cx, &file, mode);
            em.emit_template(doc);
            let result = em.finish();
            diags.extend(result.diags);
            if *kind == TemplateKind::Layout {
                cx.layouts.borrow_mut().insert(
                    id.clone(),
                    LayoutInfo {
                        slots: result.slots,
                        fragments: result.fragments.clone(),
                    },
                );
            }
            out.templates.insert(
                id.clone(),
                CompiledTemplate {
                    kind: *kind,
                    source: result.source,
                    fragments: (*kind == TemplateKind::Page).then_some(result.fragments),
                },
            );
        }

        // Step 4: minijinja compiles every emitted source.
        if diags.is_empty() {
            let mut env = Environment::empty();
            for (id, t) in &out.templates {
                if let Err(e) = env.add_template_owned(id.clone(), t.source.clone()) {
                    diags.push(diag(
                        &format!("{id}.html"),
                        format!("internal: emitted source does not compile: {e}"),
                    ));
                }
            }
        }
        if diags.is_empty() {
            Ok(out)
        } else {
            diags.sort_by(|a, b| {
                (&a.file, a.line, a.col, &a.message).cmp(&(&b.file, b.line, b.col, &b.message))
            });
            diags.dedup();
            Err(diags)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_ids() {
        assert!(is_template_id("pages/products/[id]"));
        assert!(is_template_id("partials/product-card"));
        assert!(!is_template_id("pages"));
        assert!(!is_template_id("pages/a b"));
        assert!(!is_template_id("lib/x"));
    }
}
