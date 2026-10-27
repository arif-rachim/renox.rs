//! The tree walk: emits minijinja source for a parsed template.
//!
//! Everything goes into one `String`, so consecutive static HTML is always one
//! contiguous run of text between template tags: minijinja compiles it to a
//! single `EmitRaw` instruction.

use markup5ever_rcdom::{Handle, NodeData};
use minijinja::Environment;

use crate::attrs::{self, DEFERRED_DIRECTIVES, DIRECTIVES};
use crate::parse::Document;
use crate::{Diagnostic, Output};

const VOID_ELEMENTS: [&str; 13] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];
const RAW_TEXT_ELEMENTS: [&str; 2] = ["script", "style"];

pub fn emit(doc: &Document) -> Result<Output, Vec<Diagnostic>> {
    let mut w = Walker {
        doc,
        out: String::new(),
        fragments: Vec::new(),
        diags: Vec::new(),
        env: Environment::new(),
    };
    w.emit_root();
    if w.diags.is_empty() {
        Ok(Output {
            source: w.out,
            fragments: w.fragments,
        })
    } else {
        w.diags.sort_by_key(|d| (d.line, d.col));
        Err(w.diags)
    }
}

struct Walker<'a> {
    doc: &'a Document,
    out: String,
    fragments: Vec<(String, String)>,
    diags: Vec<Diagnostic>,
    /// Only used to syntax-check directive expressions.
    env: Environment<'static>,
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

fn is_blank_text(node: &Handle) -> bool {
    match &node.data {
        NodeData::Text { contents } => contents.borrow().trim().is_empty(),
        _ => false,
    }
}

impl Walker<'_> {
    fn error(&mut self, node: &Handle, attr: Option<&str>, message: impl Into<String>) {
        let (line, col) = self.doc.position(node, attr);
        self.diags.push(Diagnostic {
            line,
            col,
            message: message.into(),
        });
    }

    /// Translates a directive expression and checks it compiles as a
    /// minijinja expression; reports at the attribute's position if not.
    fn expr(&mut self, node: &Handle, attr_name: &str, raw: &str) -> String {
        let translated = attrs::translate_expr(raw);
        if translated.is_empty() {
            self.error(
                node,
                Some(attr_name),
                format!("`{attr_name}` needs an expression"),
            );
        } else if let Err(e) = self.env.compile_expression(&translated) {
            let detail = e.detail().unwrap_or("syntax error").to_owned();
            self.error(
                node,
                Some(attr_name),
                format!("invalid expression in `{attr_name}`: {detail}"),
            );
        }
        translated
    }

    fn emit_root(&mut self) {
        let children: Vec<Handle> = self.doc.root.children.borrow().clone();
        let significant: Vec<&Handle> = children.iter().filter(|c| !is_blank_text(c)).collect();
        if let [only] = significant.as_slice()
            && element_name(only).as_deref() == Some("r-layout")
        {
            self.emit_layout(only);
            return;
        }
        self.emit_children(&children);
    }

    fn emit_layout(&mut self, node: &Handle) {
        let layout = attr(node, "use").unwrap_or_default();
        let valid = !layout.is_empty()
            && layout
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/'))
            && !layout.contains("..");
        if !valid {
            self.error(
                node,
                Some("use"),
                "`<r-layout>` needs `use=\"name\"` (letters, digits, `_`, `-`, `/`)",
            );
        }
        self.out.push_str(&format!(
            "{{% extends \"layouts/{layout}.html\" %}}{{% block body %}}"
        ));
        let children: Vec<Handle> = node.children.borrow().clone();
        self.emit_children(&children);
        self.out.push_str("{% endblock %}");
    }

    /// Emits a sibling list, grouping `r-if`/`r-else-if`/`r-else` chains and
    /// `r-for` + `r-empty` pairs. Whitespace between chained siblings is dropped.
    fn emit_children(&mut self, children: &[Handle]) {
        let mut i = 0;
        while i < children.len() {
            let node = &children[i];
            i += 1;
            if element_name(node).is_none() {
                self.emit_node(node);
                continue;
            }
            if has_attr(node, "r-else-if") || has_attr(node, "r-else") {
                let which = if has_attr(node, "r-else-if") {
                    "r-else-if"
                } else {
                    "r-else"
                };
                self.error(
                    node,
                    Some(which),
                    format!("`{which}` must follow a sibling with `r-if` or `r-else-if`"),
                );
                continue;
            }
            if has_attr(node, "r-empty") {
                self.error(
                    node,
                    Some("r-empty"),
                    "`r-empty` must follow a sibling with `r-for`",
                );
                continue;
            }
            // Collect the chain (r-if ...) or the pair (r-for, r-empty).
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
                self.emit_if_chain(&group);
            } else {
                self.emit_with_fragment(node, &group[1..]);
            }
        }
    }

    fn emit_if_chain(&mut self, chain: &[Handle]) {
        let first = &chain[0];
        let fragment = self.open_fragment(first);
        for (k, member) in chain.iter().enumerate() {
            if k > 0 && has_attr(member, "r-fragment") {
                self.error(member, Some("r-fragment"), "`r-fragment` on `r-else`/`r-else-if` is not supported; put it on the `r-if` element or a wrapper");
            }
            if k == 0 {
                let cond = self.expr(member, "r-if", &attr(member, "r-if").unwrap_or_default());
                self.out.push_str(&format!("{{% if {cond} %}}"));
            } else if let Some(raw) = attr(member, "r-else-if") {
                let cond = self.expr(member, "r-else-if", &raw);
                self.out.push_str(&format!("{{% elif {cond} %}}"));
            } else {
                self.out.push_str("{% else %}");
            }
            self.emit_loop_or_element(member, None);
        }
        self.out.push_str("{% endif %}");
        self.close_fragment(fragment);
    }

    /// `r-fragment` wraps the whole construct (condition chain or loop) so the
    /// fragment can be rendered on its own.
    fn emit_with_fragment(&mut self, node: &Handle, empty: &[Handle]) {
        let fragment = self.open_fragment(node);
        self.emit_loop_or_element(node, empty.first());
        self.close_fragment(fragment);
    }

    fn open_fragment(&mut self, node: &Handle) -> bool {
        let Some(name) = attr(node, "r-fragment") else {
            return false;
        };
        if !attrs::is_identifier(&name) {
            self.error(
                node,
                Some("r-fragment"),
                format!("fragment name `{name}` must be an identifier"),
            );
        } else if self.fragments.iter().any(|(f, _)| *f == name) {
            self.error(
                node,
                Some("r-fragment"),
                format!("fragment `{name}` is defined twice"),
            );
        }
        if has_attr(node, "r-for") {
            self.error(
                node,
                Some("r-fragment"),
                "`r-fragment` and `r-for` on one element: put the fragment on the list's parent",
            );
        }
        self.out.push_str(&format!("{{% block {name} %}}"));
        self.fragments.push((name.clone(), name));
        true
    }

    fn close_fragment(&mut self, opened: bool) {
        if opened {
            self.out.push_str("{% endblock %}");
        }
    }

    fn emit_loop_or_element(&mut self, node: &Handle, empty: Option<&Handle>) {
        let Some(raw) = attr(node, "r-for") else {
            self.emit_element(node);
            return;
        };
        if has_attr(node, "r-if") {
            self.error(
                node,
                Some("r-if"),
                "`r-if` and `r-for` on one element: wrap the element in `<r-group r-if=\"...\">`",
            );
        }
        let lp = match attrs::parse_for(&raw) {
            Ok(lp) => lp,
            Err(msg) => {
                self.error(node, Some("r-for"), msg);
                return;
            }
        };
        let iterable = self.expr(node, "r-for", &lp.iterable);
        self.out
            .push_str(&format!("{{% for {} in {iterable} %}}", lp.item));
        if let Some(index) = &lp.index {
            self.out
                .push_str(&format!("{{% set {index} = loop.index0 %}}"));
        }
        self.emit_element(node);
        if let Some(empty) = empty {
            let target = attr(empty, "r-empty").unwrap_or_default();
            if attrs::translate_expr(&target) != iterable {
                self.error(
                    empty,
                    Some("r-empty"),
                    format!(
                        "`r-empty=\"{target}\"` does not match the loop's list `{}`",
                        lp.iterable
                    ),
                );
            }
            self.out.push_str("{% else %}");
            self.emit_element(empty);
        }
        self.out.push_str("{% endfor %}");
    }

    fn emit_node(&mut self, node: &Handle) {
        match &node.data {
            NodeData::Text { contents } => attrs::escape_text(&contents.borrow(), &mut self.out),
            NodeData::Comment { contents } => {
                self.out.push_str("<!--");
                self.out.push_str(contents);
                self.out.push_str("-->");
            }
            NodeData::Doctype { name, .. } => {
                self.out.push_str("<!DOCTYPE ");
                self.out.push_str(name);
                self.out.push('>');
            }
            NodeData::Element { .. } => self.emit_children(std::slice::from_ref(node)),
            NodeData::Document | NodeData::ProcessingInstruction { .. } => {}
        }
    }

    /// Emits one element (its directives other than r-if/r-for already handled).
    fn emit_element(&mut self, node: &Handle) {
        let NodeData::Element {
            name,
            attrs: node_attrs,
            template_contents,
            ..
        } = &node.data
        else {
            self.emit_node(node);
            return;
        };
        let tag = name.local.to_string();
        let children: Vec<Handle> = match template_contents.borrow().as_ref() {
            Some(contents) => contents.children.borrow().clone(),
            None => node.children.borrow().clone(),
        };
        if tag == "r-group" {
            self.emit_children(&children);
            return;
        }
        if tag == "r-layout" {
            self.error(
                node,
                None,
                "`<r-layout>` must be the only top-level element of the template",
            );
            return;
        }
        if tag.starts_with("r-") {
            self.error(
                node,
                None,
                format!("`<{tag}>` is not supported by the F0 prototype (deferred to F2)"),
            );
            return;
        }
        if tag.starts_with("x-") {
            self.error(node, None, format!("component `<{tag}>`: components are not supported by the F0 prototype (deferred to F2)"));
            return;
        }

        let list: Vec<(String, String)> = node_attrs
            .borrow()
            .iter()
            .map(|a| (a.name.local.to_string(), a.value.to_string()))
            .collect();
        self.out.push('<');
        self.out.push_str(&tag);
        self.emit_attrs(node, &list);
        self.out.push('>');
        if VOID_ELEMENTS.contains(&tag.as_str()) {
            return;
        }
        if let Some(raw) = attr(node, "r-html") {
            if children.iter().any(|c| !is_blank_text(c)) {
                self.error(
                    node,
                    Some("r-html"),
                    "an element with `r-html` must be empty; its content is replaced",
                );
            }
            let value = self.expr(node, "r-html", &raw);
            self.out.push_str(&format!("{{{{ {value} | safe }}}}"));
        } else if RAW_TEXT_ELEMENTS.contains(&tag.as_str()) {
            let text: String = children
                .iter()
                .filter_map(|c| match &c.data {
                    NodeData::Text { contents } => Some(contents.borrow().to_string()),
                    _ => None,
                })
                .collect();
            if attrs::needs_raw(&text) {
                self.out.push_str("{% raw %}");
                self.out.push_str(&text);
                self.out.push_str("{% endraw %}");
            } else {
                self.out.push_str(&text);
            }
        } else {
            self.emit_children(&children);
        }
        self.out.push_str("</");
        self.out.push_str(&tag);
        self.out.push('>');
    }

    /// Writes attributes in source order: directives removed, `:attr`
    /// bindings compiled, static `class` merged with `:class`.
    fn emit_attrs(&mut self, node: &Handle, list: &[(String, String)]) {
        let static_class = list
            .iter()
            .find(|(n, _)| n == "class")
            .map(|(_, v)| v.clone());
        let bound_class = list
            .iter()
            .find(|(n, _)| n == ":class")
            .map(|(_, v)| v.clone());
        let mut class_done = false;
        for (name, value) in list {
            if name.starts_with("r-") {
                if DEFERRED_DIRECTIVES.contains(&name.as_str()) {
                    self.error(
                        node,
                        Some(name),
                        format!("`{name}` is not supported by the F0 prototype (deferred to F2)"),
                    );
                } else if !DIRECTIVES.contains(&name.as_str()) {
                    self.error(node, Some(name), format!("unknown directive `{name}`"));
                }
                continue;
            }
            if name == "class" || name == ":class" {
                if !class_done {
                    class_done = true;
                    self.emit_class(node, static_class.as_deref(), bound_class.as_deref());
                }
                continue;
            }
            let Some(target) = name.strip_prefix(':') else {
                attrs::write_attr(name, value, &mut self.out);
                continue;
            };
            if target.is_empty() || target.starts_with(':') {
                self.error(
                    node,
                    Some(name),
                    format!("`{name}` is not a valid attribute binding"),
                );
                continue;
            }
            let expr = self.expr(node, name, value);
            if attrs::is_boolean_attr(target) {
                self.out
                    .push_str(&format!("{{% if {expr} %}} {target}{{% endif %}}"));
            } else {
                self.out
                    .push_str(&format!(" {target}=\"{{{{ {expr} }}}}\""));
            }
        }
    }

    fn emit_class(&mut self, node: &Handle, static_class: Option<&str>, bound: Option<&str>) {
        let mut value = String::new();
        if let Some(s) = static_class {
            attrs::escape_text(s.trim(), &mut value);
            value = value.replace('"', "&quot;");
        }
        if let Some(bound) = bound {
            match attrs::parse_class_object(bound) {
                Some(Ok(pairs)) => {
                    for (class, cond) in pairs {
                        let cond = self.expr(node, ":class", &cond);
                        let sep = if value.is_empty() { "" } else { " " };
                        value.push_str(&format!("{{% if {cond} %}}{sep}{class}{{% endif %}}"));
                    }
                }
                Some(Err(msg)) => self.error(node, Some(":class"), msg),
                None => {
                    let expr = self.expr(node, ":class", bound);
                    let sep = if value.is_empty() { "" } else { " " };
                    value.push_str(&format!("{sep}{{{{ {expr} }}}}"));
                }
            }
        }
        self.out.push_str(" class=\"");
        self.out.push_str(&value);
        self.out.push('"');
    }
}
