//! Parsing with html5ever plus the source positions html5ever does not keep.
//!
//! The HTML parser ignores `/>` on elements that are not void, so
//! `<slot />`, `<r-props ... />`, `<x-card ... />`, and `<billing:badge />`
//! would swallow their following siblings. [`self_close_custom_tags`]
//! rewrites those to `<tag ...></tag>` before parsing. The rewrite adds no
//! newline, so html5ever's line numbers still match the original source,
//! which is the one scanned for positions.
//!
//! `markup5ever_rcdom` has no positions. A thin [`TreeSink`] wrapper records
//! the line the tokenizer was on when each element was created, and a small
//! scan of the raw source finds the start tags; elements are matched to
//! scanned tags in order (same name, line inside the tag), which gives exact
//! line and column for attributes in diagnostics.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use html5ever::interface::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::{Attribute, ParseOpts, QualName, local_name, ns, parse_document, parse_fragment};
use markup5ever_rcdom::{Handle, Node, NodeData, RcDom};

/// A parsed template.
pub struct Document {
    pub source: String,
    /// The node whose children are the template's top-level nodes.
    pub root: Handle,
    /// True when the input was a full document (`<!doctype` or `<html>`).
    pub is_document: bool,
    tags: Vec<ScannedTag>,
    element_tag: HashMap<*const Node, usize>,
    /// Owns the tree: dropping an `RcDom` detaches the children of every
    /// node, including those `root` still points to.
    _dom: RcDom,
}

impl Document {
    /// Position of `attr` on `element`'s start tag, or of the tag itself.
    pub fn position(&self, element: &Handle, attr: Option<&str>) -> (usize, usize) {
        let Some(&idx) = self.element_tag.get(&Rc::as_ptr(element)) else {
            return (1, 1);
        };
        let tag = &self.tags[idx];
        let mut offset = tag.start;
        if let Some(attr) = attr
            && let Some(found) = find_attr(&self.source[tag.start..tag.end], attr)
        {
            offset = tag.start + found;
        }
        line_col(&self.source, offset)
    }
}

impl Document {
    /// Position of `needle` (raw text such as `{{ x }}`) at or after the
    /// start tag of `after`, or of `after` itself when the text is not found
    /// verbatim (entities in the source).
    pub fn text_position(&self, after: Option<&Handle>, needle: &str) -> (usize, usize) {
        let from = after
            .and_then(|e| self.element_tag.get(&Rc::as_ptr(e)))
            .map_or(0, |&i| self.tags[i].start);
        match self.source[from..].find(needle) {
            Some(rel) => line_col(&self.source, from + rel),
            None => match after {
                Some(e) => self.position(e, None),
                None => (1, 1),
            },
        }
    }
}

/// Parses a template. Full documents (layouts) are parsed as documents;
/// everything else as a fragment in a `<template>` context, which accepts
/// table rows, list items, and other content anywhere.
pub fn parse(source: &str) -> Document {
    let rewritten = self_close_custom_tags(source);
    let head = source
        .trim_start()
        .get(..9)
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_document = head.starts_with("<!doctype") || head.starts_with("<html");
    let sink = LineSink::default();
    let (dom, lines) = if is_document {
        parse_document(sink, ParseOpts::default()).one(rewritten.as_str())
    } else {
        let context = QualName::new(None, ns!(html), local_name!("template"));
        parse_fragment(sink, ParseOpts::default(), context, Vec::new(), false)
            .one(rewritten.as_str())
    };
    let root = if is_document {
        dom.document.clone()
    } else {
        // Fragment parsing puts the content under a synthetic <html> element.
        dom.document.children.borrow()[0].clone()
    };
    let tags = scan_tags(source);
    let element_tag = match_elements(&tags, &lines);
    Document {
        source: source.to_owned(),
        root,
        is_document,
        tags,
        element_tag,
        _dom: dom,
    }
}

/// Custom elements that are written self-closing: `slot`, `r-*`, `x-*`,
/// and namespaced `module:component`.
pub fn is_custom_tag(name: &str) -> bool {
    name == "slot" || name.starts_with("r-") || name.starts_with("x-") || name.contains(':')
}

/// Rewrites `<custom ... />` to `<custom ...></custom>` (see the module doc).
pub fn self_close_custom_tags(src: &str) -> String {
    let mut out = String::with_capacity(src.len() + 64);
    let mut last = 0;
    for tag in scan_tags(src) {
        let raw = &src[tag.start..tag.end];
        if is_custom_tag(&tag.name) && raw.ends_with("/>") {
            out.push_str(&src[last..tag.end - 2]);
            out.push_str("></");
            out.push_str(&tag.name);
            out.push('>');
            last = tag.end;
        }
    }
    out.push_str(&src[last..]);
    out
}

/// 1-based line and column (in characters) of a byte offset.
pub fn line_col(source: &str, offset: usize) -> (usize, usize) {
    let before = &source[..offset];
    let line = before.matches('\n').count() + 1;
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    (line, source[line_start..offset].chars().count() + 1)
}

// ---------------------------------------------------------------------------
// Sink: RcDom plus the tokenizer line of every created element.
// ---------------------------------------------------------------------------

struct LineSink {
    dom: RcDom,
    line: Cell<u64>,
    /// (element, line) in creation order.
    created: RefCell<Vec<(Handle, u64)>>,
}

impl Default for LineSink {
    fn default() -> Self {
        // html5ever reports line changes only; the first line is 1.
        LineSink {
            dom: RcDom::default(),
            line: Cell::new(1),
            created: RefCell::default(),
        }
    }
}

impl TreeSink for LineSink {
    type Handle = Handle;
    type Output = (RcDom, Vec<(Handle, u64)>);
    type ElemName<'a> = <RcDom as TreeSink>::ElemName<'a>;

    fn finish(self) -> Self::Output {
        (self.dom, self.created.into_inner())
    }
    fn parse_error(&self, msg: Cow<'static, str>) {
        self.dom.parse_error(msg)
    }
    fn get_document(&self) -> Handle {
        self.dom.get_document()
    }
    fn elem_name<'a>(&'a self, target: &'a Handle) -> Self::ElemName<'a> {
        self.dom.elem_name(target)
    }
    fn create_element(&self, name: QualName, attrs: Vec<Attribute>, flags: ElementFlags) -> Handle {
        let handle = self.dom.create_element(name, attrs, flags);
        self.created
            .borrow_mut()
            .push((handle.clone(), self.line.get()));
        handle
    }
    fn create_comment(&self, text: StrTendril) -> Handle {
        self.dom.create_comment(text)
    }
    fn create_pi(&self, target: StrTendril, data: StrTendril) -> Handle {
        self.dom.create_pi(target, data)
    }
    fn append(&self, parent: &Handle, child: NodeOrText<Handle>) {
        self.dom.append(parent, child)
    }
    fn append_based_on_parent_node(
        &self,
        element: &Handle,
        prev: &Handle,
        child: NodeOrText<Handle>,
    ) {
        self.dom.append_based_on_parent_node(element, prev, child)
    }
    fn append_doctype_to_document(
        &self,
        name: StrTendril,
        public_id: StrTendril,
        system_id: StrTendril,
    ) {
        self.dom
            .append_doctype_to_document(name, public_id, system_id)
    }
    fn mark_script_already_started(&self, node: &Handle) {
        self.dom.mark_script_already_started(node)
    }
    fn pop(&self, node: &Handle) {
        self.dom.pop(node)
    }
    fn get_template_contents(&self, target: &Handle) -> Handle {
        self.dom.get_template_contents(target)
    }
    fn same_node(&self, x: &Handle, y: &Handle) -> bool {
        self.dom.same_node(x, y)
    }
    fn set_quirks_mode(&self, mode: QuirksMode) {
        self.dom.set_quirks_mode(mode)
    }
    fn append_before_sibling(&self, sibling: &Handle, new_node: NodeOrText<Handle>) {
        self.dom.append_before_sibling(sibling, new_node)
    }
    fn add_attrs_if_missing(&self, target: &Handle, attrs: Vec<Attribute>) {
        self.dom.add_attrs_if_missing(target, attrs)
    }
    fn associate_with_form(
        &self,
        target: &Handle,
        form: &Handle,
        nodes: (&Handle, Option<&Handle>),
    ) {
        self.dom.associate_with_form(target, form, nodes)
    }
    fn remove_from_parent(&self, target: &Handle) {
        self.dom.remove_from_parent(target)
    }
    fn reparent_children(&self, node: &Handle, new_parent: &Handle) {
        self.dom.reparent_children(node, new_parent)
    }
    fn is_mathml_annotation_xml_integration_point(&self, handle: &Handle) -> bool {
        self.dom.is_mathml_annotation_xml_integration_point(handle)
    }
    fn set_current_line(&self, line_number: u64) {
        self.line.set(line_number)
    }
}

// ---------------------------------------------------------------------------
// Source scan: start tags with byte ranges and lines.
// ---------------------------------------------------------------------------

struct ScannedTag {
    name: String,
    start: usize,
    end: usize,
    start_line: u64,
    end_line: u64,
}

const RAW_TEXT: [&str; 4] = ["script", "style", "textarea", "title"];

fn scan_tags(src: &str) -> Vec<ScannedTag> {
    let bytes = src.as_bytes();
    let mut tags = Vec::new();
    let mut i = 0;
    let mut line = 1u64;
    let mut line_at = 0usize; // offset `line` was computed for
    let mut line_of = |offset: usize| {
        line += bytes[line_at..offset]
            .iter()
            .filter(|&&b| b == b'\n')
            .count() as u64;
        line_at = offset;
        line
    };
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        if src[i..].starts_with("<!--") {
            i = src[i + 4..]
                .find("-->")
                .map_or(bytes.len(), |e| i + 4 + e + 3);
            continue;
        }
        let name_start = i + 1;
        if !bytes.get(name_start).is_some_and(u8::is_ascii_alphabetic) {
            i += 1;
            continue;
        }
        let mut j = name_start;
        while j < bytes.len()
            && !matches!(
                bytes[j],
                b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/' | b'>'
            )
        {
            j += 1;
        }
        let name = src[name_start..j].to_ascii_lowercase();
        // Find the end of the tag, skipping quoted attribute values.
        let mut quote = None;
        while j < bytes.len() {
            match (quote, bytes[j]) {
                (None, b'"' | b'\'') => quote = Some(bytes[j]),
                (Some(q), b) if b == q => quote = None,
                (None, b'>') => break,
                _ => {}
            }
            j += 1;
        }
        let end = (j + 1).min(bytes.len());
        let start_line = line_of(i);
        let end_line = line_of(end.saturating_sub(1).max(i));
        tags.push(ScannedTag {
            name: name.clone(),
            start: i,
            end,
            start_line,
            end_line,
        });
        i = end;
        if RAW_TEXT.contains(&name.as_str()) {
            let close = format!("</{name}");
            let lower = src[i..].to_ascii_lowercase();
            i = lower.find(&close).map_or(bytes.len(), |e| i + e);
        }
    }
    tags
}

/// Matches created elements to scanned tags. Implied elements (`tbody`,
/// `html`, `body` when absent from the source) find no tag and get none.
fn match_elements(tags: &[ScannedTag], created: &[(Handle, u64)]) -> HashMap<*const Node, usize> {
    let mut map = HashMap::new();
    let mut cursor = 0;
    for (handle, line) in created {
        let NodeData::Element { name, .. } = &handle.data else {
            continue;
        };
        let name = name.local.as_ref();
        let found = tags[cursor..]
            .iter()
            .position(|t| t.name == name && t.start_line <= *line && *line <= t.end_line);
        if let Some(rel) = found {
            map.insert(Rc::as_ptr(handle), cursor + rel);
            cursor += rel + 1;
        }
    }
    map
}

/// Byte offset of attribute `attr` inside one start tag's source.
fn find_attr(tag: &str, attr: &str) -> Option<usize> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find(attr) {
        let at = from + rel;
        let before_ok = lower[..at].ends_with(|c: char| c.is_ascii_whitespace());
        let after = lower[at + attr.len()..].chars().next();
        let after_ok = matches!(after, None | Some('=' | '>' | '/'))
            || after.is_some_and(|c| c.is_ascii_whitespace());
        if before_ok && after_ok {
            return Some(at);
        }
        from = at + attr.len();
    }
    None
}
