//! The tree walk: emits minijinja source for one template.
//!
//! Everything goes into one `String`, so consecutive static HTML is one
//! contiguous run of text between template tags, which minijinja compiles to
//! a single `EmitRaw` instruction.
//!
//! Components are inlined: `<x-card :product="p">` becomes
//!
//! ```text
//! {% with __a1_0 = (p), __s1_product = product %}{% with product = __a1_0 %}
//!   ...card body, <slot /> = caller content inside {% with product = __s1_product %}...
//! {% endwith %}{% endwith %}
//! ```
//!
//! Prop values are evaluated first under fresh names, then bound, so a prop
//! expression never sees another prop. Slot content runs in the caller's
//! scope: names the props shadow are restored around it.

use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use markup5ever_rcdom::{Handle, NodeData};
use minijinja::Environment;

use super::attrs::{self, DIRECTIVES, Segment};
use super::parse::Document;
use super::{CompileCx, Component, MAX_COMPONENT_DEPTH, Prop, PropType};
use crate::{Diagnostic, Fragment, PLATFORM_VAR};

const VOID_ELEMENTS: [&str; 13] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];
const RAW_TEXT_ELEMENTS: [&str; 2] = ["script", "style"];
/// Elements that never get `dir="auto"`.
const NO_DIR_AUTO: [&str; 7] = [
    "html", "head", "body", "script", "style", "title", "template",
];
/// The default slot and the layout block that holds a page's content.
const DEFAULT_SLOT: &str = "content";
/// Names the compiler binds; templates cannot use them as variables.
const CAN_FN: &str = "can";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// `pages/_layouts/*`: `<slot>` becomes a block.
    Layout,
    /// Pages, error pages, partials.
    Template,
}

/// Where a node comes from: its document and file, and the component call
/// it is inside (for `<slot>`).
#[derive(Clone)]
struct Ctx {
    doc: Rc<Document>,
    file: Rc<str>,
    frame: Option<Rc<Frame>>,
}

/// One inlined component call.
struct Frame {
    id: usize,
    caller: Ctx,
    /// The call element (position of slot content diagnostics).
    call: Handle,
    default: Vec<Handle>,
    named: BTreeMap<String, Vec<Handle>>,
    /// Prop names, restored around slot content.
    saved: Vec<String>,
    /// Length of the component stack at the call: slot content is the
    /// caller's, so it may use the same component again.
    depth: usize,
}

pub(crate) struct EmitResult {
    pub source: String,
    pub fragments: BTreeMap<String, Fragment>,
    pub slots: Vec<String>,
    pub diags: Vec<Diagnostic>,
}

pub(crate) struct Emitter<'c, 'p> {
    cx: &'c CompileCx<'p>,
    file: String,
    mode: Mode,
    out: String,
    fragments: BTreeMap<String, Fragment>,
    /// Every block name emitted (fragments and layout slots).
    blocks: BTreeSet<String>,
    slots: Vec<String>,
    diags: Vec<Diagnostic>,
    components: Vec<String>,
    next_id: usize,
    /// Non-zero inside a loop body or an inlined component: a block there would
    /// not see the loop variable or the props when rendered on its own.
    scoped: usize,
}

fn element_name(node: &Handle) -> Option<String> {
    match &node.data {
        NodeData::Element { name, .. } => Some(name.local.to_string()),
        _ => None,
    }
}

fn attr(node: &Handle, name: &str) -> Option<String> {
    match &node.data {
        NodeData::Element { attrs, .. } => attrs
            .borrow()
            .iter()
            .find(|a| a.name.local.as_ref() == name)
            .map(|a| a.value.to_string()),
        _ => None,
    }
}

fn has_attr(node: &Handle, name: &str) -> bool {
    attr(node, name).is_some()
}

fn attr_list(node: &Handle) -> Vec<(String, String)> {
    match &node.data {
        NodeData::Element { attrs, .. } => attrs
            .borrow()
            .iter()
            .map(|a| (a.name.local.to_string(), a.value.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn is_blank_text(node: &Handle) -> bool {
    match &node.data {
        NodeData::Text { contents } => contents.borrow().trim().is_empty(),
        NodeData::Comment { .. } => false,
        _ => false,
    }
}

fn children_of(node: &Handle) -> Vec<Handle> {
    if let NodeData::Element {
        template_contents, ..
    } = &node.data
        && let Some(contents) = template_contents.borrow().as_ref()
    {
        return contents.children.borrow().clone();
    }
    node.children.borrow().clone()
}

fn text_of(nodes: &[Handle]) -> String {
    nodes
        .iter()
        .filter_map(|c| match &c.data {
            NodeData::Text { contents } => Some(contents.borrow().to_string()),
            _ => None,
        })
        .collect()
}

/// The hidden CSRF field (`<x-csrf>`, and the first child of `<x-form>`).
fn csrf_input() -> String {
    format!("<input type=\"hidden\" name=\"_csrf\" value=\"{{{{ {PLATFORM_VAR}.csrf_token }}}}\">")
}

/// A page action name (`docs/contracts/artifact.md`, page route `actions`).
fn is_page_action_name(s: &str) -> bool {
    let mut c = s.chars();
    c.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && s.len() <= 64
        && c.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn is_component_tag(tag: &str) -> bool {
    tag.starts_with("x-") || tag.contains(':')
}

/// Prop names are attribute names (lower case); `max-items` binds `max_items`.
fn prop_var(name: &str) -> String {
    name.replace('-', "_")
}

/// Reads `<r-props>` and the slot names of a component file.
pub(crate) fn read_component(
    cx: &CompileCx<'_>,
    path: &str,
    doc: Rc<Document>,
    diags: &mut Vec<Diagnostic>,
) -> Component {
    let mut props = Vec::new();
    let mut declares_props = false;
    let mut slots = BTreeSet::new();
    let mut stack: Vec<Handle> = doc.root.children.borrow().clone();
    let top: Vec<Handle> = stack.clone();
    while let Some(node) = stack.pop() {
        match element_name(&node).as_deref() {
            Some("r-props") => {
                if !top.iter().any(|t| Rc::ptr_eq(t, &node)) {
                    let (line, col) = doc.position(&node, None);
                    diags.push(Diagnostic {
                        file: path.to_string(),
                        line,
                        col,
                        message: "`<r-props>` must be at the top level of the partial".into(),
                    });
                }
                declares_props = true;
                for (name, spec) in attr_list(&node) {
                    let (line, col) = doc.position(&node, Some(&name));
                    let mut err = |message: String| {
                        diags.push(Diagnostic {
                            file: path.to_string(),
                            line,
                            col,
                            message,
                        })
                    };
                    let var = prop_var(&name);
                    if !attrs::is_identifier(&var) || var.starts_with("__") || var == CAN_FN {
                        err(format!("prop name `{name}` is not an identifier"));
                        continue;
                    }
                    let (ty, default) = match spec.split_once('=') {
                        Some((t, d)) => (t.trim(), Some(d.trim())),
                        None => (spec.trim(), None),
                    };
                    let ty = match ty {
                        "bool" | "boolean" => PropType::Bool,
                        "string" => PropType::String,
                        "number" => PropType::Number,
                        "" => {
                            err(format!(
                                "prop `{name}` needs a type: `bool`, `string`, `number`, or a type name"
                            ));
                            continue;
                        }
                        other => PropType::Any(other.to_string()),
                    };
                    let default = match default {
                        Some(d) => match cx.checker.check(d) {
                            Ok(e) => Some(e),
                            Err(m) => {
                                err(format!("default of prop `{name}`: {m}"));
                                continue;
                            }
                        },
                        None => None,
                    };
                    props.push(Prop {
                        name: var,
                        ty,
                        default,
                    });
                }
            }
            Some("slot") => {
                slots.insert(attr(&node, "name").unwrap_or_else(|| DEFAULT_SLOT.into()));
                stack.extend(children_of(&node));
            }
            _ => stack.extend(children_of(&node)),
        }
    }
    Component {
        path: path.to_string(),
        doc,
        props,
        declares_props,
        slots,
    }
}

impl<'c, 'p> Emitter<'c, 'p> {
    pub fn new(cx: &'c CompileCx<'p>, file: &str, mode: Mode) -> Emitter<'c, 'p> {
        Emitter {
            cx,
            file: file.to_string(),
            mode,
            out: String::new(),
            fragments: BTreeMap::new(),
            blocks: BTreeSet::new(),
            slots: Vec::new(),
            diags: Vec::new(),
            components: Vec::new(),
            next_id: 0,
            scoped: 0,
        }
    }

    pub fn finish(self) -> EmitResult {
        EmitResult {
            source: self.out,
            fragments: self.fragments,
            slots: self.slots,
            diags: self.diags,
        }
    }

    fn error(&mut self, ctx: &Ctx, node: &Handle, attr: Option<&str>, message: impl Into<String>) {
        let (line, col) = ctx.doc.position(node, attr);
        self.diags.push(Diagnostic {
            file: ctx.file.to_string(),
            line,
            col,
            message: message.into(),
        });
    }

    /// Checks a directive expression; reports at the attribute.
    fn expr(&mut self, ctx: &Ctx, node: &Handle, attr_name: &str, raw: &str) -> String {
        match self.cx.checker.check(raw) {
            Ok(e) => e,
            Err(m) => {
                self.error(ctx, node, Some(attr_name), format!("`{attr_name}`: {m}"));
                "none".into()
            }
        }
    }

    pub fn emit_template(&mut self, doc: Rc<Document>) {
        let ctx = Ctx {
            doc: doc.clone(),
            file: Rc::from(self.file.as_str()),
            frame: None,
        };
        let children: Vec<Handle> = doc.root.children.borrow().clone();
        let significant: Vec<&Handle> = children.iter().filter(|c| !is_blank_text(c)).collect();
        if let [only] = significant.as_slice()
            && element_name(only).as_deref() == Some("r-layout")
        {
            let only = (*only).clone();
            self.emit_layout_use(&ctx, &only);
            return;
        }
        self.emit_children(&ctx, None, &children);
    }

    /// `<r-layout use="main">`: `{% extends %}` with the children in
    /// `{% block content %}` and `slot="x"` children in `{% block x %}`.
    fn emit_layout_use(&mut self, ctx: &Ctx, node: &Handle) {
        let name = attr(node, "use").unwrap_or_default();
        let id = format!("pages/_layouts/{name}");
        let valid = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
        if self.mode == Mode::Layout {
            self.error(ctx, node, None, "a layout cannot use another layout");
            return;
        }
        let layout = self.cx.layouts.borrow().get(&id).cloned();
        let Some(layout) = layout.filter(|_| valid) else {
            self.error(
                ctx,
                node,
                Some("use"),
                format!("unknown layout `{name}`: expected pages/_layouts/{name}.html"),
            );
            return;
        };
        for (other, a) in attr_list(node) {
            if other != "use" {
                self.error(
                    ctx,
                    node,
                    Some(&other),
                    format!("`<r-layout>` takes only `use`, not `{a}`"),
                );
            }
        }
        // The layout's slots are blocks of this template; its fragments are
        // part of this page's map.
        self.blocks.extend(layout.slots.iter().cloned());
        for (fname, f) in &layout.fragments {
            self.blocks.insert(fname.clone());
            self.fragments.insert(fname.clone(), f.clone());
        }
        self.out
            .push_str(&format!("{{% extends {} %}}", attrs::string_literal(&id)));
        let mut default = Vec::new();
        let mut named: Vec<(String, Handle)> = Vec::new();
        for child in children_of(node) {
            match attr(&child, "slot") {
                Some(slot) if element_name(&child).is_some() => named.push((slot, child)),
                _ => default.push(child),
            }
        }
        let mut filled = BTreeSet::new();
        for (slot, child) in named {
            if !layout.slots.contains(&slot) {
                self.error(
                    ctx,
                    &child,
                    Some("slot"),
                    format!("layout `{name}` has no slot `{slot}`"),
                );
                continue;
            }
            if !filled.insert(slot.clone()) {
                self.error(
                    ctx,
                    &child,
                    Some("slot"),
                    format!("slot `{slot}` is filled twice"),
                );
                continue;
            }
            self.out.push_str(&format!("{{% block {slot} %}}"));
            self.emit_slot_child(ctx, node, &child);
            self.out.push_str("{% endblock %}");
        }
        if default.iter().any(|c| !is_blank_text(c)) {
            if !layout.slots.iter().any(|s| s == DEFAULT_SLOT) {
                self.error(
                    ctx,
                    node,
                    None,
                    format!("layout `{name}` has no default `<slot />` for the page content"),
                );
                return;
            }
            self.out.push_str("{% block content %}");
            self.emit_children(ctx, Some(node), &default);
            self.out.push_str("{% endblock %}");
        }
    }

    /// Emits a `slot="x"` child: `<r-group slot>` contributes its children,
    /// any other element is emitted without the `slot` attribute.
    fn emit_slot_child(&mut self, ctx: &Ctx, parent: &Handle, child: &Handle) {
        if element_name(child).as_deref() == Some("r-group") {
            self.emit_children(ctx, Some(parent), &children_of(child));
        } else {
            self.emit_children(ctx, Some(parent), std::slice::from_ref(child));
        }
    }

    /// Emits a sibling list, grouping `r-if`/`r-else-if`/`r-else` chains and
    /// `r-for` + `r-empty` pairs. Whitespace between chained siblings is dropped.
    fn emit_children(&mut self, ctx: &Ctx, parent: Option<&Handle>, children: &[Handle]) {
        let mut i = 0;
        while i < children.len() {
            let node = &children[i];
            i += 1;
            if element_name(node).is_none() {
                self.emit_node(ctx, parent, node);
                continue;
            }
            if has_attr(node, "r-else-if") || has_attr(node, "r-else") {
                let which = if has_attr(node, "r-else-if") {
                    "r-else-if"
                } else {
                    "r-else"
                };
                self.error(
                    ctx,
                    node,
                    Some(which),
                    format!("`{which}` must follow a sibling with `r-if` or `r-else-if`"),
                );
                continue;
            }
            if has_attr(node, "r-empty") {
                self.error(
                    ctx,
                    node,
                    Some("r-empty"),
                    "`r-empty` must follow a sibling with `r-for`",
                );
                continue;
            }
            let mut group = vec![node.clone()];
            let continues = |n: &Handle, first: &Handle| {
                if has_attr(first, "r-if") {
                    has_attr(n, "r-else-if") || has_attr(n, "r-else")
                } else if has_attr(first, "r-for") {
                    has_attr(n, "r-empty")
                } else {
                    false
                }
            };
            loop {
                let mut j = i;
                while j < children.len() && is_blank_text(&children[j]) {
                    j += 1;
                }
                let Some(next) = children.get(j) else { break };
                let last = group.last().expect("group is never empty");
                let more = continues(next, node)
                    && !(has_attr(node, "r-for") && group.len() == 2)
                    && !(has_attr(last, "r-else") && !has_attr(last, "r-if"));
                if !more {
                    break;
                }
                group.push(next.clone());
                i = j + 1;
            }
            if has_attr(node, "r-if") {
                self.emit_if_chain(ctx, &group);
            } else {
                let fragment = self.open_fragment(ctx, node);
                self.emit_loop_or_element(ctx, node, group.get(1));
                self.close_fragment(fragment);
            }
        }
    }

    fn emit_if_chain(&mut self, ctx: &Ctx, chain: &[Handle]) {
        let fragment = self.open_fragment(ctx, &chain[0]);
        for (k, member) in chain.iter().enumerate() {
            if k > 0 && has_attr(member, "r-fragment") {
                self.error(
                    ctx,
                    member,
                    Some("r-fragment"),
                    "`r-fragment` on `r-else`/`r-else-if` is not supported; put it on the `r-if` element or a wrapper",
                );
            }
            if k == 0 {
                let raw = attr(member, "r-if").unwrap_or_default();
                let cond = self.expr(ctx, member, "r-if", &raw);
                self.out.push_str(&format!("{{% if {cond} %}}"));
            } else if let Some(raw) = attr(member, "r-else-if") {
                let cond = self.expr(ctx, member, "r-else-if", &raw);
                self.out.push_str(&format!("{{% elif {cond} %}}"));
            } else {
                self.out.push_str("{% else %}");
            }
            self.emit_loop_or_element(ctx, member, None);
        }
        self.out.push_str("{% endif %}");
        self.close_fragment(fragment);
    }

    /// `r-fragment` wraps the whole construct (condition chain or loop) in a
    /// block so the fragment can be rendered on its own.
    fn open_fragment(&mut self, ctx: &Ctx, node: &Handle) -> bool {
        let Some(name) = attr(node, "r-fragment") else {
            return false;
        };
        if !attrs::is_fragment_name(&name) {
            self.error(
                ctx,
                node,
                Some("r-fragment"),
                format!("fragment name `{name}` must match [a-z_][a-z0-9_]* (at most 64)"),
            );
            return false;
        }
        if self.blocks.contains(&name) {
            let what = if self.fragments.contains_key(&name) {
                "fragment"
            } else {
                "layout slot"
            };
            self.error(
                ctx,
                node,
                Some("r-fragment"),
                format!("fragment `{name}`: a {what} with this name already exists"),
            );
            return false;
        }
        if has_attr(node, "r-for") {
            self.error(
                ctx,
                node,
                Some("r-fragment"),
                "`r-fragment` and `r-for` on one element: put the fragment on the list's parent",
            );
        }
        if self.scoped > 0 {
            self.error(
                ctx,
                node,
                Some("r-fragment"),
                "`r-fragment` inside an `r-for` loop or a component: a fragment renders on its own, without the loop variable or the props; put it around the loop or the component",
            );
            return false;
        }
        let target = attr(node, "id").filter(|id| !id.contains("{{"));
        if let Some(t) = &target
            && !attrs::is_fragment_target(t)
        {
            self.error(
                ctx,
                node,
                Some("id"),
                format!("fragment target id `{t}` must match [A-Za-z][A-Za-z0-9_:.-]*"),
            );
        }
        if let Some(t) = &target
            && self
                .fragments
                .values()
                .any(|f| f.target.as_ref() == Some(t))
        {
            self.error(
                ctx,
                node,
                Some("id"),
                format!("two fragments target the same id `{t}`"),
            );
        }
        self.blocks.insert(name.clone());
        self.fragments.insert(name.clone(), Fragment { target });
        self.out.push_str(&format!("{{% block {name} %}}"));
        true
    }

    fn close_fragment(&mut self, opened: bool) {
        if opened {
            self.out.push_str("{% endblock %}");
        }
    }

    fn emit_loop_or_element(&mut self, ctx: &Ctx, node: &Handle, empty: Option<&Handle>) {
        let Some(raw) = attr(node, "r-for") else {
            self.emit_element(ctx, node);
            return;
        };
        if has_attr(node, "r-if") {
            self.error(
                ctx,
                node,
                Some("r-if"),
                "`r-if` and `r-for` on one element: wrap the element in `<r-group r-if=\"...\">`",
            );
        }
        let lp = match attrs::parse_for(&raw) {
            Ok(lp) => lp,
            Err(msg) => {
                self.error(ctx, node, Some("r-for"), msg);
                return;
            }
        };
        let iterable = self.expr(ctx, node, "r-for", &lp.iterable);
        // `__loop` counts iterations against the render's iteration limit.
        self.out
            .push_str(&format!("{{% for {} in ({iterable}) | __loop %}}", lp.item));
        if let Some(index) = &lp.index {
            self.out
                .push_str(&format!("{{% set {index} = loop.index0 %}}"));
        }
        self.scoped += 1;
        self.emit_element(ctx, node);
        self.scoped -= 1;
        if let Some(empty) = empty {
            let target = attr(empty, "r-empty").unwrap_or_default();
            let target_expr = self.cx.checker.check(&target).unwrap_or_default();
            if target_expr != iterable {
                self.error(
                    ctx,
                    empty,
                    Some("r-empty"),
                    format!(
                        "`r-empty=\"{target}\"` does not match the loop's list `{}`",
                        lp.iterable
                    ),
                );
            }
            self.out.push_str("{% else %}");
            self.emit_element(ctx, empty);
        }
        self.out.push_str("{% endfor %}");
    }

    fn emit_node(&mut self, ctx: &Ctx, parent: Option<&Handle>, node: &Handle) {
        match &node.data {
            NodeData::Text { contents } => {
                let text = contents.borrow().to_string();
                self.emit_text(ctx, parent, &text);
            }
            NodeData::Comment { contents } => {
                // Comments are dropped unless they are conditional-comment
                // style markers; template syntax inside them is never emitted.
                if contents.contains("{{") || contents.contains("{%") {
                    return;
                }
                self.out.push_str("<!--");
                attrs::escape_text(contents, &mut self.out);
                self.out.push_str("-->");
            }
            NodeData::Doctype { name, .. } => {
                self.out.push_str("<!DOCTYPE ");
                self.out.push_str(name);
                self.out.push('>');
            }
            NodeData::Element { .. } => {
                self.emit_children(ctx, parent, std::slice::from_ref(node));
            }
            NodeData::Document | NodeData::ProcessingInstruction { .. } => {}
        }
    }

    /// Text with `{{ }}` interpolations; static parts escaped.
    fn emit_text(&mut self, ctx: &Ctx, parent: Option<&Handle>, text: &str) {
        for seg in attrs::segments(text) {
            match seg {
                Segment::Static(s) => attrs::escape_text(s, &mut self.out),
                Segment::Interp(inner) => match self.cx.checker.check(inner) {
                    Ok(e) => self.out.push_str(&format!("{{{{ {e} }}}}")),
                    Err(m) => {
                        let (line, col) =
                            ctx.doc.text_position(parent, &format!("{{{{{inner}}}}}"));
                        self.push_diag(ctx, line, col, format!("`{{{{{inner}}}}}`: {m}"));
                    }
                },
                Segment::Statement => {
                    let (line, col) = ctx.doc.text_position(parent, "{%");
                    self.push_diag(
                        ctx,
                        line,
                        col,
                        "template statements (`{% %}`, `{# #}`) are not part of the template language; use r-* directives",
                    );
                }
                Segment::Unclosed => {
                    let (line, col) = ctx.doc.text_position(parent, "{{");
                    self.push_diag(ctx, line, col, "`{{` without a closing `}}`");
                }
            }
        }
    }

    fn push_diag(&mut self, ctx: &Ctx, line: usize, col: usize, message: impl Into<String>) {
        self.diags.push(Diagnostic {
            file: ctx.file.to_string(),
            line,
            col,
            message: message.into(),
        });
    }

    /// `r-can` / `r-cannot`: opens `{% if can(action, resource) %}`.
    fn open_can(&mut self, ctx: &Ctx, node: &Handle) -> bool {
        let (directive, negate) = match (attr(node, "r-can"), attr(node, "r-cannot")) {
            (Some(_), Some(_)) => {
                self.error(
                    ctx,
                    node,
                    Some("r-cannot"),
                    "`r-can` and `r-cannot` on one element",
                );
                return false;
            }
            (Some(a), None) => (("r-can", a), false),
            (None, Some(a)) => (("r-cannot", a), true),
            (None, None) => return false,
        };
        let (name, action) = directive;
        let action = action.trim().to_string();
        if !attrs::is_action_name(&action) {
            self.error(
                ctx,
                node,
                Some(name),
                format!("`{name}` needs an action name such as `cart.add`, got `{action}`"),
            );
            return false;
        }
        if let Some(known) = &self.cx.options.actions
            && !known.contains(&action)
        {
            self.error(
                ctx,
                node,
                Some(name),
                format!("unknown action `{action}` in `{name}`"),
            );
        }
        let resource = match attr(node, ":resource") {
            Some(raw) => self.expr(ctx, node, ":resource", &raw),
            None => "none".into(),
        };
        let not = if negate { "not " } else { "" };
        self.out.push_str(&format!(
            "{{% if {not}{CAN_FN}({}, {resource}) %}}",
            attrs::string_literal(&action)
        ));
        true
    }

    /// Emits one element (`r-if`/`r-for` already handled by the caller).
    fn emit_element(&mut self, ctx: &Ctx, node: &Handle) {
        let Some(tag) = element_name(node) else {
            self.emit_node(ctx, None, node);
            return;
        };
        let can = self.open_can(ctx, node);
        self.emit_element_inner(ctx, node, &tag);
        if can {
            self.out.push_str("{% endif %}");
        }
    }

    fn emit_element_inner(&mut self, ctx: &Ctx, node: &Handle, tag: &str) {
        let children = children_of(node);
        match tag {
            "r-group" => {
                self.check_directives(ctx, node, &["r-html"]);
                self.emit_children(ctx, Some(node), &children);
                return;
            }
            "r-layout" => {
                self.error(
                    ctx,
                    node,
                    None,
                    "`<r-layout>` must be the only top-level element of the template",
                );
                return;
            }
            "r-props" => {
                // Read by `read_component`; emits nothing.
                return;
            }
            "r-slot" => {
                self.emit_registry_slot(ctx, node);
                return;
            }
            "r-t" => {
                self.emit_translation(ctx, node, &children);
                return;
            }
            "slot" => {
                self.emit_slot(ctx, node, &children);
                return;
            }
            _ if tag.starts_with("r-") => {
                self.error(ctx, node, None, format!("unknown element `<{tag}>`"));
                return;
            }
            "x-csrf" => {
                self.check_directives(ctx, node, &["r-html"]);
                if children.iter().any(|c| !is_blank_text(c)) {
                    self.error(ctx, node, None, "`<x-csrf>` takes no content");
                }
                self.out.push_str(&csrf_input());
                return;
            }
            "x-form" => {
                self.emit_x_form(ctx, node, &children);
                return;
            }
            "x-script" => {
                self.emit_x_script(ctx, node, &children);
                return;
            }
            _ if is_component_tag(tag) => {
                self.emit_component(ctx, node, tag);
                return;
            }
            _ => {}
        }

        let list = attr_list(node);
        self.out.push('<');
        self.out.push_str(tag);
        self.emit_attrs(ctx, node, tag, &list);
        if tag == "html"
            && !list
                .iter()
                .any(|(n, _)| matches!(n.trim_start_matches(':'), "lang" | "dir"))
        {
            // The page's locale and direction from the render (`ops.md`
            // section 14, "Locale"), unless the template sets either.
            self.out.push_str(&format!(
                " lang=\"{{{{ {PLATFORM_VAR}.lang }}}}\" dir=\"{{{{ {PLATFORM_VAR}.dir }}}}\""
            ));
        }
        if RAW_TEXT_ELEMENTS.contains(&tag) {
            self.out.push_str(&format!(
                "{{% if {PLATFORM_VAR}.csp_nonce %}} nonce=\"{{{{ {PLATFORM_VAR}.csp_nonce }}}}\"{{% endif %}}"
            ));
        } else if self.wants_dir_auto(node, tag, &list, &children) {
            self.out.push_str(" dir=\"auto\"");
        }
        self.out.push('>');
        if VOID_ELEMENTS.contains(&tag) {
            return;
        }
        if let Some(raw) = attr(node, "r-html") {
            if children.iter().any(|c| !is_blank_text(c)) {
                self.error(
                    ctx,
                    node,
                    Some("r-html"),
                    "an element with `r-html` must be empty; its content is replaced",
                );
            }
            let value = self.expr(ctx, node, "r-html", &raw);
            self.out.push_str(&format!("{{{{ ({value}) | safe }}}}"));
        } else if RAW_TEXT_ELEMENTS.contains(&tag) {
            emit_raw(&text_of(&children), &mut self.out);
        } else if tag == "title"
            && self.mode == Mode::Layout
            && text_of(&children).contains("<slot")
        {
            let text = text_of(&children);
            self.emit_title_slots(ctx, node, &text);
        } else {
            self.emit_children(ctx, Some(node), &children);
        }
        self.out.push_str("</");
        self.out.push_str(tag);
        self.out.push('>');
    }

    /// `<x-form action="name">`: a `<form>` that posts to the page action
    /// `?/name` (plain and htmx) and carries the CSRF field
    /// (`docs/08-template-engine.md`, "Built-in components"; #41).
    fn emit_x_form(&mut self, ctx: &Ctx, node: &Handle, children: &[Handle]) {
        self.check_directives(ctx, node, &["r-html"]);
        let action = attr(node, "action").unwrap_or_default();
        let action = action.trim().to_string();
        if !is_page_action_name(&action) {
            self.error(
                ctx,
                node,
                Some("action"),
                format!(
                    "`<x-form>` needs `action` naming a page action (`addToCart`), got `{action}`"
                ),
            );
            return;
        }
        let list: Vec<(String, String)> = attr_list(node)
            .into_iter()
            .filter(|(n, _)| {
                !matches!(
                    n.as_str(),
                    "action" | ":action" | "method" | ":method" | "hx-post"
                )
            })
            .collect();
        let target = format!("?/{action}");
        self.out.push_str("<form method=\"post\" action=\"");
        attrs::escape_attr(&target, '"', &mut self.out);
        self.out.push_str("\" hx-post=\"");
        attrs::escape_attr(&target, '"', &mut self.out);
        self.out.push('"');
        self.emit_attrs(ctx, node, "form", &list);
        self.out.push('>');
        self.out.push_str(&csrf_input());
        self.emit_children(ctx, Some(node), children);
        self.out.push_str("</form>");
    }

    /// `<x-script src="...">`: a `<script>` with the per-request CSP nonce.
    fn emit_x_script(&mut self, ctx: &Ctx, node: &Handle, children: &[Handle]) {
        self.check_directives(ctx, node, &["r-html"]);
        if children.iter().any(|c| !is_blank_text(c)) {
            self.error(ctx, node, None, "`<x-script>` takes no content; use `src`");
        }
        let list = attr_list(node);
        self.out.push_str("<script");
        self.emit_attrs(ctx, node, "script", &list);
        self.out.push_str(&format!(
            "{{% if {PLATFORM_VAR}.csp_nonce %}} nonce=\"{{{{ {PLATFORM_VAR}.csp_nonce }}}}\"{{% endif %}}"
        ));
        self.out.push_str("></script>");
    }

    /// `dir="auto"` on elements that show user text: direct text with an
    /// interpolation, `r-html`, or a bound `value` on a text input
    /// (`docs/08-template-engine.md`, "Right-to-left").
    fn wants_dir_auto(
        &self,
        node: &Handle,
        tag: &str,
        list: &[(String, String)],
        children: &[Handle],
    ) -> bool {
        if NO_DIR_AUTO.contains(&tag) || list.iter().any(|(n, _)| n == "dir" || n == ":dir") {
            return false;
        }
        if has_attr(node, "r-html") {
            return true;
        }
        if tag == "input" {
            let ty = attr(node, "type").unwrap_or_default();
            return has_attr(node, ":value")
                && matches!(
                    ty.as_str(),
                    "" | "text" | "search" | "email" | "url" | "tel"
                );
        }
        children.iter().any(|c| match &c.data {
            NodeData::Text { contents } => contents.borrow().contains("{{"),
            _ => false,
        })
    }

    /// Reports `r-*` attributes that make no sense on this element.
    fn check_directives(&mut self, ctx: &Ctx, node: &Handle, refused: &[&str]) {
        for (name, _) in attr_list(node) {
            if refused.contains(&name.as_str()) {
                self.error(
                    ctx,
                    node,
                    Some(&name),
                    format!("`{name}` is not allowed here"),
                );
            } else if name.starts_with("r-") && !DIRECTIVES.contains(&name.as_str()) {
                self.error(
                    ctx,
                    node,
                    Some(&name),
                    format!("unknown directive `{name}`"),
                );
            }
        }
    }

    /// Writes attributes in source order: directives removed, `:attr`
    /// bindings compiled, static `class` merged with `:class`.
    fn emit_attrs(&mut self, ctx: &Ctx, node: &Handle, tag: &str, list: &[(String, String)]) {
        let static_class = list
            .iter()
            .find(|(n, _)| n == "class")
            .map(|(_, v)| v.clone());
        let bound_class = list
            .iter()
            .find(|(n, _)| n == ":class")
            .map(|(_, v)| v.clone());
        let has_can = has_attr(node, "r-can") || has_attr(node, "r-cannot");
        let mut class_done = false;
        for (name, value) in list {
            if name.starts_with("r-") {
                if !DIRECTIVES.contains(&name.as_str()) {
                    self.error(ctx, node, Some(name), format!("unknown directive `{name}`"));
                }
                continue;
            }
            if name == "slot" || (name == ":resource" && has_can) {
                continue;
            }
            if name == "nonce" || name == ":nonce" {
                self.error(
                    ctx,
                    node,
                    Some(name),
                    "`nonce` is set by the platform (CSP); remove it",
                );
                continue;
            }
            if name == "class" || name == ":class" {
                if !class_done {
                    class_done = true;
                    self.emit_class(ctx, node, static_class.as_deref(), bound_class.as_deref());
                }
                continue;
            }
            let Some(target) = name.strip_prefix(':') else {
                self.emit_static_attr(ctx, node, name, value);
                continue;
            };
            if target.is_empty() || target.starts_with(':') || target.starts_with("r-") {
                self.error(
                    ctx,
                    node,
                    Some(name),
                    format!("`{name}` is not a valid attribute binding"),
                );
                continue;
            }
            if target.starts_with("on") {
                self.error(
                    ctx,
                    node,
                    Some(name),
                    format!("`{name}`: event handler attributes cannot be bound"),
                );
                continue;
            }
            let expr = self.expr(ctx, node, name, value);
            if attrs::is_boolean_attr(target) {
                self.out
                    .push_str(&format!("{{% if {expr} %}} {target}{{% endif %}}"));
            } else if attrs::URL_ATTRS.contains(&target) {
                self.out
                    .push_str(&format!(" {target}=\"{{{{ ({expr}) | __url }}}}\""));
            } else {
                self.out
                    .push_str(&format!(" {target}=\"{{{{ {expr} }}}}\""));
            }
        }
        let _ = tag;
    }

    fn emit_static_attr(&mut self, ctx: &Ctx, node: &Handle, name: &str, value: &str) {
        self.out.push(' ');
        self.out.push_str(name);
        if value.is_empty() && attrs::is_boolean_attr(name) {
            return;
        }
        let quote = attrs::pick_quote(value);
        self.out.push('=');
        self.out.push(quote);
        let url = attrs::URL_ATTRS.contains(&name);
        for (i, seg) in attrs::segments(value).into_iter().enumerate() {
            match seg {
                Segment::Static(s) => attrs::escape_attr(s, quote, &mut self.out),
                Segment::Interp(inner) => match self.cx.checker.check(inner) {
                    Ok(e) if url && i == 0 => {
                        self.out.push_str(&format!("{{{{ ({e}) | __url }}}}"))
                    }
                    Ok(e) => self.out.push_str(&format!("{{{{ {e} }}}}")),
                    Err(m) => self.error(ctx, node, Some(name), format!("`{name}`: {m}")),
                },
                Segment::Statement => self.error(
                    ctx,
                    node,
                    Some(name),
                    "template statements (`{% %}`, `{# #}`) are not part of the template language",
                ),
                Segment::Unclosed => {
                    self.error(ctx, node, Some(name), "`{{` without a closing `}}`")
                }
            }
        }
        self.out.push(quote);
    }

    fn emit_class(
        &mut self,
        ctx: &Ctx,
        node: &Handle,
        static_class: Option<&str>,
        bound: Option<&str>,
    ) {
        let mut value = String::new();
        if let Some(s) = static_class {
            attrs::escape_attr(s.trim(), '"', &mut value);
        }
        if let Some(bound) = bound {
            match attrs::parse_class_object(bound) {
                Some(Ok(pairs)) => {
                    for (class, cond) in pairs {
                        let cond = self.expr(ctx, node, ":class", &cond);
                        let sep = if value.is_empty() { "" } else { " " };
                        value.push_str(&format!("{{% if {cond} %}}{sep}{class}{{% endif %}}"));
                    }
                }
                Some(Err(msg)) => self.error(ctx, node, Some(":class"), msg),
                None => {
                    let expr = self.expr(ctx, node, ":class", bound);
                    let sep = if value.is_empty() { "" } else { " " };
                    value.push_str(&format!("{sep}{{{{ {expr} }}}}"));
                }
            }
        }
        self.out.push_str(" class=\"");
        self.out.push_str(&value);
        self.out.push('"');
    }

    /// `<r-t key="cart.items" :count="cart.count" />`: the translated message
    /// (`t` filter, render/i18n.rs). Plain attributes are text arguments,
    /// `:name` attributes expressions.
    fn emit_translation(&mut self, ctx: &Ctx, node: &Handle, children: &[Handle]) {
        if children.iter().any(|c| !is_blank_text(c)) {
            self.error(ctx, node, None, "`<r-t>` takes no content; use `key`");
        }
        let Some(key) = attr(node, "key").filter(|k| is_message_key(k)) else {
            self.error(
                ctx,
                node,
                Some("key"),
                "`<r-t>` needs `key` naming a catalog message, such as `cart.items`",
            );
            return;
        };
        let mut args = Vec::new();
        for (name, raw) in attr_list(node) {
            if name == "key" {
                continue;
            }
            let (bound, plain) = match name.strip_prefix(':') {
                Some(n) => (true, n.to_string()),
                None => (false, name.clone()),
            };
            if !is_arg_name(&plain) {
                self.error(
                    ctx,
                    node,
                    Some(&name),
                    format!("`<r-t>` argument `{plain}` must match [a-z_][a-z0-9_]*"),
                );
                return;
            }
            let value = if bound {
                format!("({})", self.expr(ctx, node, &name, &raw))
            } else {
                attrs::string_literal(&raw)
            };
            args.push(format!("{}: {value}", attrs::string_literal(&plain)));
        }
        let key = attrs::string_literal(&key);
        if args.is_empty() {
            self.out.push_str(&format!("{{{{ {key} | t }}}}"));
        } else {
            self.out
                .push_str(&format!("{{{{ {key} | t({{{}}}) }}}}", args.join(", ")));
        }
    }

    /// `<r-slot name="admin.sidebar" />`: one `{% include %}` per provider
    /// in the slot registry, in order; nothing when no module fills it.
    fn emit_registry_slot(&mut self, ctx: &Ctx, node: &Handle) {
        let Some(name) = attr(node, "name").filter(|n| !n.is_empty()) else {
            self.error(ctx, node, None, "`<r-slot>` needs `name=\"module.slot\"`");
            return;
        };
        if !attrs::is_action_name(&name) {
            self.error(
                ctx,
                node,
                Some("name"),
                format!("slot name `{name}` must be a dotted name such as `admin.sidebar`"),
            );
            return;
        }
        if children_of(node).iter().any(|c| !is_blank_text(c)) {
            self.error(
                ctx,
                node,
                None,
                "`<r-slot>` has no content; providers fill it",
            );
        }
        let providers = self
            .cx
            .options
            .slots
            .get(&name)
            .cloned()
            .unwrap_or_default();
        for id in providers {
            self.out
                .push_str(&format!("{{% include {} %}}", attrs::string_literal(&id)));
        }
    }

    /// `<slot>`: in a layout, a block; inside an inlined component, the
    /// caller's content (or the fallback children); elsewhere the fallback.
    fn emit_slot(&mut self, ctx: &Ctx, node: &Handle, fallback: &[Handle]) {
        let name = attr(node, "name").unwrap_or_else(|| DEFAULT_SLOT.into());
        if !attrs::is_fragment_name(&name) {
            self.error(
                ctx,
                node,
                Some("name"),
                format!("slot name `{name}` must match [a-z_][a-z0-9_]*"),
            );
            return;
        }
        if let Some(frame) = ctx.frame.clone() {
            let content = if name == DEFAULT_SLOT {
                frame.default.clone()
            } else {
                frame.named.get(&name).cloned().unwrap_or_default()
            };
            if content.iter().all(is_blank_text) {
                self.emit_children(ctx, Some(node), fallback);
                return;
            }
            if !frame.saved.is_empty() {
                let restore: Vec<String> = frame
                    .saved
                    .iter()
                    .map(|p| format!("{p} = __s{}_{p}", frame.id))
                    .collect();
                self.out
                    .push_str(&format!("{{% with {} %}}", restore.join(", ")));
            }
            let inner = self.components.split_off(frame.depth);
            if name == DEFAULT_SLOT {
                self.emit_children(&frame.caller, Some(&frame.call), &content);
            } else {
                for child in &content {
                    self.emit_slot_child(&frame.caller, &frame.call, child);
                }
            }
            self.components.extend(inner);
            if !frame.saved.is_empty() {
                self.out.push_str("{% endwith %}");
            }
            return;
        }
        if self.mode == Mode::Layout && self.components.is_empty() {
            if !self.blocks.insert(name.clone()) {
                self.error(
                    ctx,
                    node,
                    Some("name"),
                    format!("slot `{name}` is defined twice"),
                );
                return;
            }
            self.slots.push(name.clone());
            self.out.push_str(&format!("{{% block {name} %}}"));
            self.emit_children(ctx, Some(node), fallback);
            self.out.push_str("{% endblock %}");
            return;
        }
        self.emit_children(ctx, Some(node), fallback);
    }

    /// `<title><slot name="title">Shop</slot> · Store</title>` in a layout.
    /// `<title>` is raw text for the HTML parser, so the slot markup arrives
    /// as text and is resolved here.
    fn emit_title_slots(&mut self, ctx: &Ctx, node: &Handle, text: &str) {
        let mut rest = text;
        while let Some(start) = rest.find("<slot") {
            self.emit_text(ctx, Some(node), &rest[..start]);
            let after = &rest[start..];
            let Some(tag_end) = after.find('>') else {
                self.error(ctx, node, None, "unterminated `<slot>` in `<title>`");
                return;
            };
            let tag = &after[..=tag_end];
            let name = tag
                .split("name=")
                .nth(1)
                .and_then(|v| {
                    let q = v.chars().next()?;
                    let v = &v[1..];
                    v.find(q).map(|e| v[..e].to_string())
                })
                .unwrap_or_else(|| DEFAULT_SLOT.into());
            let (fallback, consumed) = if tag.ends_with("/>") {
                ("", tag_end + 1)
            } else {
                match after[tag_end + 1..].find("</slot>") {
                    Some(e) => (
                        &after[tag_end + 1..tag_end + 1 + e],
                        tag_end + 1 + e + "</slot>".len(),
                    ),
                    None => {
                        self.error(ctx, node, None, "`<slot>` in `<title>` without `</slot>`");
                        return;
                    }
                }
            };
            if !attrs::is_fragment_name(&name) || !self.blocks.insert(name.clone()) {
                self.error(
                    ctx,
                    node,
                    None,
                    format!("slot `{name}` in `<title>` is invalid or defined twice"),
                );
                return;
            }
            self.slots.push(name.clone());
            self.out.push_str(&format!("{{% block {name} %}}"));
            self.emit_text(ctx, Some(node), fallback);
            self.out.push_str("{% endblock %}");
            rest = &after[consumed..];
        }
        self.emit_text(ctx, Some(node), rest);
    }

    /// Inlines `<x-name>` / `<module:name>` (see the module doc).
    fn emit_component(&mut self, ctx: &Ctx, node: &Handle, tag: &str) {
        let Some(path) = self.cx.component_path(tag) else {
            let hint = if let Some(name) = tag.strip_prefix("x-") {
                format!("partials/{name}.html")
            } else {
                let (m, n) = tag.split_once(':').unwrap_or(("", tag));
                format!("modules/{m}/partials/{n}.html")
            };
            self.error(
                ctx,
                node,
                None,
                format!("unknown component `<{tag}>`: expected {hint}"),
            );
            return;
        };
        if self.components.contains(&path) || self.components.len() >= MAX_COMPONENT_DEPTH {
            self.error(
                ctx,
                node,
                None,
                format!(
                    "component `<{tag}>` includes itself or nests deeper than {MAX_COMPONENT_DEPTH}"
                ),
            );
            return;
        }
        let Some(comp) = self.cx.component(&path, &mut self.diags) else {
            return;
        };
        self.check_component_body(&comp);
        self.check_directives(ctx, node, &["r-html"]);

        // Props from the call's attributes.
        let mut values: BTreeMap<String, String> = BTreeMap::new();
        let has_can = has_attr(node, "r-can") || has_attr(node, "r-cannot");
        for (name, value) in attr_list(node) {
            if name.starts_with("r-") || name == "slot" || (name == ":resource" && has_can) {
                continue;
            }
            let (bound, raw_name) = match name.strip_prefix(':') {
                Some(n) => (true, n.to_string()),
                None => (false, name.clone()),
            };
            let var = prop_var(&raw_name);
            let Some(prop) = comp.props.iter().find(|p| p.name == var) else {
                self.error(
                    ctx,
                    node,
                    Some(&name),
                    format!("`<{tag}>` has no prop `{raw_name}` (declare it in `<r-props>`)"),
                );
                continue;
            };
            let expr = if bound {
                self.expr(ctx, node, &name, &value)
            } else {
                match static_prop(&prop.ty, &value) {
                    Ok(e) => e,
                    Err(m) => {
                        self.error(ctx, node, Some(&name), format!("prop `{raw_name}`: {m}"));
                        continue;
                    }
                }
            };
            if values.insert(var.clone(), expr).is_some() {
                self.error(
                    ctx,
                    node,
                    Some(&name),
                    format!("prop `{raw_name}` is given twice"),
                );
            }
        }
        for prop in &comp.props {
            if values.contains_key(&prop.name) {
                continue;
            }
            match &prop.default {
                Some(d) => {
                    values.insert(prop.name.clone(), d.clone());
                }
                None => self.error(
                    ctx,
                    node,
                    None,
                    format!("`<{tag}>` needs the prop `{}`", prop.name),
                ),
            }
        }

        // Slot content from the call's children.
        let mut default = Vec::new();
        let mut named: BTreeMap<String, Vec<Handle>> = BTreeMap::new();
        for child in children_of(node) {
            match attr(&child, "slot") {
                Some(slot) if element_name(&child).is_some() => {
                    if !comp.slots.contains(&slot) {
                        self.error(
                            ctx,
                            &child,
                            Some("slot"),
                            format!("`<{tag}>` has no slot `{slot}`"),
                        );
                        continue;
                    }
                    named.entry(slot).or_default().push(child);
                }
                _ => default.push(child),
            }
        }
        if default.iter().any(|c| !is_blank_text(c)) && !comp.slots.contains(DEFAULT_SLOT) {
            self.error(
                ctx,
                node,
                None,
                format!("`<{tag}>` has no default `<slot />` for its content"),
            );
        }
        let has_content = !named.is_empty() || default.iter().any(|c| !is_blank_text(c));

        self.next_id += 1;
        let id = self.next_id;
        let saved: Vec<String> = if has_content {
            comp.props.iter().map(|p| p.name.clone()).collect()
        } else {
            Vec::new()
        };
        let mut first: Vec<String> = values
            .iter()
            .enumerate()
            .map(|(k, (_, e))| format!("__a{id}_{k} = ({e})"))
            .collect();
        first.extend(saved.iter().map(|p| format!("__s{id}_{p} = {p}")));
        let bind: Vec<String> = values
            .keys()
            .enumerate()
            .map(|(k, p)| format!("{p} = __a{id}_{k}"))
            .collect();
        if !first.is_empty() {
            self.out
                .push_str(&format!("{{% with {} %}}", first.join(", ")));
        }
        if !bind.is_empty() {
            self.out
                .push_str(&format!("{{% with {} %}}", bind.join(", ")));
        }
        let frame = Frame {
            id,
            caller: ctx.clone(),
            call: node.clone(),
            default,
            named,
            saved,
            depth: self.components.len(),
        };
        let comp_ctx = Ctx {
            doc: comp.doc.clone(),
            file: Rc::from(comp.path.as_str()),
            frame: Some(Rc::new(frame)),
        };
        self.components.push(path.clone());
        self.scoped += 1;
        let body: Vec<Handle> = comp.doc.root.children.borrow().clone();
        self.emit_children(&comp_ctx, None, &body);
        self.scoped -= 1;
        self.components.pop();
        if !bind.is_empty() {
            self.out.push_str("{% endwith %}");
        }
        if !first.is_empty() {
            self.out.push_str("{% endwith %}");
        }
    }

    /// Once per component: a component that declares `<r-props>` may only
    /// read its props (and loop variables); anything else is a diagnostic.
    fn check_component_body(&mut self, comp: &Component) {
        if !self
            .cx
            .checked_components
            .borrow_mut()
            .insert(comp.path.clone())
        {
            return;
        }
        if !comp.declares_props {
            return;
        }
        let mut em = Emitter::new(self.cx, &comp.path, Mode::Template);
        em.components = self.components.clone();
        em.components.push(comp.path.clone());
        let ctx = Ctx {
            doc: comp.doc.clone(),
            file: Rc::from(comp.path.as_str()),
            frame: None,
        };
        let body: Vec<Handle> = comp.doc.root.children.borrow().clone();
        em.emit_children(&ctx, None, &body);
        let EmitResult { source, diags, .. } = em.finish();
        self.diags.extend(diags);
        let mut env = Environment::empty();
        if env.add_template_owned("c", source).is_err() {
            return;
        }
        let Ok(t) = env.get_template("c") else {
            return;
        };
        let mut unknown: Vec<String> = t
            .undeclared_variables(false)
            .into_iter()
            .filter(|v| {
                !v.starts_with("__")
                    && v != CAN_FN
                    && v != "loop"
                    && !comp.props.iter().any(|p| &p.name == v)
            })
            .collect();
        unknown.sort();
        for v in unknown {
            self.diags.push(Diagnostic {
                file: comp.path.clone(),
                line: 1,
                col: 1,
                message: format!(
                    "the component uses `{v}`, which is not a prop; declare it in `<r-props>`"
                ),
            });
        }
    }
}

/// A static attribute value for a prop of type `ty`, as an expression.
fn static_prop(ty: &PropType, value: &str) -> Result<String, String> {
    match ty {
        PropType::Bool => match value {
            "" | "true" => Ok("true".into()),
            "false" => Ok("false".into()),
            other => Err(format!(
                "`{other}` is not a boolean; use `:name=\"expr\"` for an expression"
            )),
        },
        PropType::Number => value
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(|_| value.trim().to_string())
            .ok_or_else(|| format!("`{value}` is not a number")),
        PropType::String | PropType::Any(_) => {
            if value.contains("{{") {
                return Err("interpolation in a prop value: bind it with `:name=\"expr\"`".into());
            }
            Ok(attrs::string_literal(value))
        }
    }
}

/// `<script>`/`<style>` content stays literal: wrapped in `{% raw %}` when
/// it contains template delimiters, with any `{%` (which could close the
/// raw block) emitted as a string.
fn emit_raw(text: &str, out: &mut String) {
    if !(text.contains("{{") || text.contains("{%") || text.contains("{#")) {
        out.push_str(text);
        return;
    }
    out.push_str("{% raw %}");
    for (i, part) in text.split("{%").enumerate() {
        if i > 0 {
            out.push_str("{% endraw %}{{ \"{%\" }}{% raw %}");
        }
        out.push_str(part);
    }
    out.push_str("{% endraw %}");
}

/// A catalog key: dotted segments of `[A-Za-z0-9_-]`.
fn is_message_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 128
        && k.split('.').all(|seg| {
            !seg.is_empty()
                && seg
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

fn is_arg_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_lowercase() || b[0] == b'_')
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}
