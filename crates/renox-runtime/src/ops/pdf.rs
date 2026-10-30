//! `ctx.pdf` (`docs/contracts/ops.md` 1.7.0 section 24; #322): a template
//! the cell renders to HTML, laid out and written as PDF in Rust.
//!
//! | Step | Here |
//! | --- | --- |
//! | Template → HTML | the cell's renderer, through [`TemplateHost`] (the renderer never runs tenant code) |
//! | HTML → document | [`to_typst`]: the HTML subset of invoices and reports (headings, paragraphs, `strong`/`em`, `br`, lists, tables, `hr`) as typst code; `<html dir lang>` sets the direction and language |
//! | Layout and shaping | `typst` (rustybuzz shaping, Unicode bidi), with the bundled Noto Sans and Noto Naskh Arabic only: no system fonts, no remote resources |
//! | PDF | `typst-pdf` |
//! | Limits | 200 pages and 20 MB of output (*proposed*): `RENOX_PDF_LIMIT` |
//!
//! Every text node becomes a typst string literal, so template data can
//! never be read as typst markup or code.

use std::sync::{Arc, OnceLock};

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

/// Output limits (*proposed*, ops.md section 24).
pub const MAX_PAGES: usize = 200;
pub const MAX_BYTES: usize = 20 * 1024 * 1024;

/// The page options of `ctx.pdf.render`.
#[derive(Debug, Clone, PartialEq)]
pub struct PdfOptions {
    pub page: String,
    pub landscape: bool,
    pub margin_mm: f64,
}

impl Default for PdfOptions {
    fn default() -> Self {
        PdfOptions {
            page: "A4".into(),
            landscape: false,
            margin_mm: 15.0,
        }
    }
}

impl PdfOptions {
    /// From the bootstrap's JSON (`{ page, orientation, marginMm }`).
    pub fn from_json(v: &serde_json::Value) -> Result<PdfOptions, String> {
        let mut o = PdfOptions::default();
        if let Some(p) = v.get("page").and_then(|p| p.as_str()) {
            if !matches!(p, "A4" | "Letter" | "A5") {
                return Err("page is A4, Letter or A5".into());
            }
            o.page = p.into();
        }
        match v.get("orientation").and_then(|p| p.as_str()) {
            None | Some("portrait") => {}
            Some("landscape") => o.landscape = true,
            Some(_) => return Err("orientation is portrait or landscape".into()),
        }
        if let Some(m) = v.get("marginMm").or_else(|| v.get("margin_mm")) {
            let m = m.as_f64().ok_or("marginMm is a number")?;
            if !(0.0..=50.0).contains(&m) {
                return Err("marginMm is 0 to 50".into());
            }
            o.margin_mm = m;
        }
        Ok(o)
    }
}

/// Why a render failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfError {
    /// Past `MAX_PAGES` or `MAX_BYTES` (`RENOX_PDF_LIMIT`).
    Limit(String),
    /// The template or the layout failed.
    Render(String),
}

/// The cell's renderer: a page or partial template of the deployment with
/// its data, as HTML.
pub trait TemplateHost: Send + Sync {
    fn render(&self, template: &str, data_json: &str) -> Result<String, String>;
}

/// What the cell gives an [`crate::IsolateSpec`].
#[derive(Clone)]
pub struct TemplateSlot(pub Arc<dyn TemplateHost>);

impl std::fmt::Debug for TemplateSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TemplateSlot")
    }
}

const FONTS: &[&[u8]] = &[
    include_bytes!("../../fonts/NotoSans-Regular.ttf"),
    include_bytes!("../../fonts/NotoSans-Bold.ttf"),
    include_bytes!("../../fonts/NotoNaskhArabic-Regular.ttf"),
    include_bytes!("../../fonts/NotoNaskhArabic-Bold.ttf"),
];

struct Shared {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
}

fn shared() -> &'static Shared {
    static S: OnceLock<Shared> = OnceLock::new();
    S.get_or_init(|| {
        let fonts: Vec<Font> = FONTS
            .iter()
            .flat_map(|data| Font::iter(Bytes::new(*data)))
            .collect();
        Shared {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(FontBook::from_fonts(&fonts)),
            fonts,
        }
    })
}

struct Doc {
    main: Source,
}

impl World for Doc {
    fn library(&self) -> &LazyHash<Library> {
        &shared().library
    }
    fn book(&self) -> &LazyHash<FontBook> {
        &shared().book
    }
    fn main(&self) -> FileId {
        self.main.id()
    }
    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main.id() {
            Ok(self.main.clone())
        } else {
            Err(FileError::AccessDenied)
        }
    }
    fn file(&self, _id: FileId) -> FileResult<Bytes> {
        // No images, no includes, no remote resources.
        Err(FileError::AccessDenied)
    }
    fn font(&self, index: usize) -> Option<Font> {
        shared().fonts.get(index).cloned()
    }
    fn today(&self, _offset: Option<typst::foundations::Duration>) -> Option<Datetime> {
        None
    }
}

// ---------------------------------------------------------------------------
// HTML -> typst code.

use html5ever::tendril::TendrilSink;
use markup5ever_rcdom::{Handle, NodeData, RcDom};

fn string_lit(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' | '\r' | '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn attr(node: &Handle, name: &str) -> Option<String> {
    if let NodeData::Element { attrs, .. } = &node.data {
        attrs
            .borrow()
            .iter()
            .find(|a| &*a.name.local == name)
            .map(|a| a.value.to_string())
    } else {
        None
    }
}

fn tag(node: &Handle) -> Option<String> {
    match &node.data {
        NodeData::Element { name, .. } => Some(name.local.to_string()),
        _ => None,
    }
}

/// Inline content of `node` as a typst content expression `[...]`.
fn inline(node: &Handle, out: &mut String) {
    for child in node.children.borrow().iter() {
        match &child.data {
            NodeData::Text { contents } => {
                let t = contents.borrow().to_string();
                let collapsed: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
                if collapsed.is_empty() {
                    if !t.is_empty() {
                        out.push(' ');
                    }
                    continue;
                }
                if t.starts_with(char::is_whitespace) {
                    out.push(' ');
                }
                out.push('#');
                out.push_str(&string_lit(&collapsed));
                if t.ends_with(char::is_whitespace) {
                    out.push(' ');
                }
            }
            NodeData::Element { .. } => match tag(child).as_deref() {
                Some("br") => out.push_str(" #linebreak() "),
                Some("strong" | "b" | "th") => {
                    out.push_str("#strong[");
                    inline(child, out);
                    out.push(']');
                }
                Some("em" | "i") => {
                    out.push_str("#emph[");
                    inline(child, out);
                    out.push(']');
                }
                Some("script" | "style" | "head" | "template") => {}
                _ => inline(child, out),
            },
            _ => {}
        }
    }
}

fn cells(row: &Handle) -> Vec<Handle> {
    row.children
        .borrow()
        .iter()
        .filter(|c| matches!(tag(c).as_deref(), Some("td" | "th")))
        .cloned()
        .collect()
}

fn rows(table: &Handle) -> Vec<Handle> {
    let mut out = Vec::new();
    for c in table.children.borrow().iter() {
        match tag(c).as_deref() {
            Some("tr") => out.push(c.clone()),
            Some("thead" | "tbody" | "tfoot") => out.extend(rows(c)),
            _ => {}
        }
    }
    out
}

/// Block content of `node` as typst code lines.
fn blocks(node: &Handle, out: &mut String) {
    for child in node.children.borrow().iter() {
        match &child.data {
            NodeData::Text { contents } => {
                let t = contents.borrow().to_string();
                let t: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
                if !t.is_empty() {
                    out.push_str(&format!("#par[#{}]\n", string_lit(&t)));
                }
            }
            NodeData::Element { .. } => {
                let name = tag(child).unwrap_or_default();
                match name.as_str() {
                    "h1" | "h2" | "h3" | "h4" => {
                        let level = &name[1..];
                        out.push_str(&format!("#heading(level: {level}, outlined: false)["));
                        inline(child, out);
                        out.push_str("]\n");
                    }
                    "p" => {
                        out.push_str("#par[");
                        inline(child, out);
                        out.push_str("]\n");
                    }
                    "hr" => out.push_str("#line(length: 100%)\n"),
                    "ul" | "ol" => {
                        let f = if name == "ul" { "list" } else { "enum" };
                        out.push_str(&format!("#{f}("));
                        for li in child
                            .children
                            .borrow()
                            .iter()
                            .filter(|c| tag(c).as_deref() == Some("li"))
                        {
                            out.push('[');
                            inline(li, out);
                            out.push_str("], ");
                        }
                        out.push_str(")\n");
                    }
                    "table" => {
                        let rs = rows(child);
                        let cols = rs.iter().map(|r| cells(r).len()).max().unwrap_or(1).max(1);
                        out.push_str(&format!("#table(columns: {cols}, "));
                        for r in &rs {
                            let cs = cells(r);
                            for i in 0..cols {
                                out.push('[');
                                if let Some(c) = cs.get(i) {
                                    if tag(c).as_deref() == Some("th") {
                                        out.push_str("#strong[");
                                        inline(c, out);
                                        out.push(']');
                                    } else {
                                        inline(c, out);
                                    }
                                }
                                out.push_str("], ");
                            }
                        }
                        out.push_str(")\n");
                    }
                    "script" | "style" | "head" | "template" => {}
                    "span" | "strong" | "b" | "em" | "i" | "a" | "small" => {
                        out.push_str("#par[");
                        inline(child, out);
                        out.push_str("]\n");
                    }
                    // div, section, article, body, header, footer, main, …
                    _ => {
                        let dir = attr(child, "dir");
                        if let Some(d) = dir.as_deref().filter(|d| *d == "rtl" || *d == "ltr") {
                            out.push_str(&format!("#[#set text(dir: {d})\n"));
                            blocks(child, out);
                            out.push_str("]\n");
                        } else {
                            blocks(child, out);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn find(node: &Handle, name: &str) -> Option<Handle> {
    if tag(node).as_deref() == Some(name) {
        return Some(node.clone());
    }
    node.children.borrow().iter().find_map(|c| find(c, name))
}

/// The typst source of an HTML document or fragment.
pub fn to_typst(html: &str, options: &PdfOptions) -> String {
    let dom = html5ever::parse_document(RcDom::default(), Default::default()).one(html);
    let root = dom.document.clone();
    let html_el = find(&root, "html");
    let dir = html_el
        .as_ref()
        .and_then(|h| attr(h, "dir"))
        .filter(|d| d == "rtl" || d == "ltr");
    let lang = html_el
        .as_ref()
        .and_then(|h| attr(h, "lang"))
        .map(|l| l.split('-').next().unwrap_or("en").to_ascii_lowercase())
        .filter(|l| l.len() == 2 && l.chars().all(|c| c.is_ascii_lowercase()))
        .unwrap_or_else(|| "en".into());
    let paper = match options.page.as_str() {
        "Letter" => "us-letter",
        "A5" => "a5",
        _ => "a4",
    };
    let mut out = format!(
        "#set page(paper: \"{paper}\", flipped: {}, margin: {}mm)\n#set text(font: (\"Noto Sans\", \"Noto Naskh Arabic\"), size: 10pt, lang: \"{lang}\"{})\n#set table(inset: 5pt)\n",
        options.landscape,
        options.margin_mm,
        dir.map(|d| format!(", dir: {d}")).unwrap_or_default(),
    );
    let body = find(&root, "body").unwrap_or(root);
    blocks(&body, &mut out);
    out
}

/// Lays `html` out; the document, for the PDF writer and the tests.
pub fn layout(html: &str, options: &PdfOptions) -> Result<typst_layout::PagedDocument, PdfError> {
    let world = Doc {
        main: Source::detached(to_typst(html, options)),
    };
    let doc = typst::compile::<typst_layout::PagedDocument>(&world)
        .output
        .map_err(|errs| {
            PdfError::Render(
                errs.iter()
                    .map(|e| e.message.to_string())
                    .collect::<Vec<_>>()
                    .join("; "),
            )
        })?;
    if doc.pages().len() > MAX_PAGES {
        return Err(PdfError::Limit(format!(
            "{} pages, at most {MAX_PAGES}",
            doc.pages().len()
        )));
    }
    Ok(doc)
}

/// HTML to PDF bytes.
pub fn html_to_pdf(html: &str, options: &PdfOptions) -> Result<Vec<u8>, PdfError> {
    let doc = layout(html, options)?;
    let bytes = typst_pdf::pdf(&doc, &typst_pdf::PdfOptions::default()).map_err(|errs| {
        PdfError::Render(
            errs.iter()
                .map(|e| e.message.to_string())
                .collect::<Vec<_>>()
                .join("; "),
        )
    })?;
    if bytes.len() > MAX_BYTES {
        return Err(PdfError::Limit(format!(
            "{} bytes, at most {MAX_BYTES}",
            bytes.len()
        )));
    }
    Ok(bytes)
}

/// The text runs of a laid-out document in reading order of the frames,
/// with each run's font family (tests: order, shaping font, direction).
pub fn text_runs(doc: &typst_layout::PagedDocument) -> Vec<(String, String)> {
    fn walk(frame: &typst::layout::Frame, out: &mut Vec<(String, String)>) {
        for (_, item) in frame.items() {
            match item {
                typst::layout::FrameItem::Group(g) => walk(&g.frame, out),
                typst::layout::FrameItem::Text(t) => {
                    out.push((t.text.to_string(), t.font.info().family.clone()));
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    for page in doc.pages() {
        walk(&page.frame, &mut out);
    }
    out
}

#[cfg(feature = "v8")]
pub(crate) use ops::*;

#[cfg(feature = "v8")]
mod ops {
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::time::Instant;

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;

    use super::*;
    use crate::ops::request::{live_request, op_error};

    /// The renderer of one isolate's `ctx.pdf`.
    pub struct PdfEnv {
        pub templates: Option<Arc<dyn TemplateHost>>,
    }

    /// `op_render_pdf(token, template, dataJson, optionsJson)`: the PDF bytes.
    #[op2]
    #[buffer]
    pub(crate) async fn op_render_pdf(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] template: String,
        #[string] data_json: String,
        #[string] options_json: String,
    ) -> Result<Vec<u8>, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let host = state.borrow().borrow::<Rc<PdfEnv>>().templates.clone();
        let Some(host) = host else {
            return Err(op_error(
                "RENOX_INTERNAL",
                serde_json::json!({ "reason": "no_templates" }),
                "This deployment has no templates to render.",
            ));
        };
        let options: serde_json::Value =
            serde_json::from_str(&options_json).unwrap_or(serde_json::Value::Null);
        let options = PdfOptions::from_json(&options)
            .map_err(|m| JsErrorBox::range_error(format!("pdf.render: {m}")))?;
        let started = Instant::now();
        let out = tokio::task::spawn_blocking(move || {
            let html = host
                .render(&template, &data_json)
                .map_err(PdfError::Render)?;
            html_to_pdf(&html, &options)
        })
        .await
        .map_err(|_| {
            op_error(
                "RENOX_INTERNAL",
                serde_json::Value::Null,
                "The PDF render failed.",
            )
        })?;
        request.borrow_mut().render_pdf_ms += started.elapsed().as_secs_f64() * 1000.0;
        match out {
            Ok(bytes) => Ok(bytes),
            Err(PdfError::Limit(m)) => Err(op_error(
                "RENOX_PDF_LIMIT",
                serde_json::json!({ "reason": m }),
                "The PDF is over its page or size limit.",
            )),
            Err(PdfError::Render(m)) => {
                tracing::warn!(error = %m, "pdf render failed");
                Err(op_error(
                    "RENOX_INTERNAL",
                    serde_json::json!({ "reason": "render" }),
                    "The PDF render failed.",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_quoted_never_markup() {
        let t = to_typst(
            "<p>#set page(width: 1pt) \\ \"x\" [y]</p>",
            &PdfOptions::default(),
        );
        assert!(
            t.contains(r##"#par[#"#set page(width: 1pt) \\ \"x\" [y]"]"##),
            "{t}"
        );
    }

    #[test]
    fn options_are_checked() {
        assert!(PdfOptions::from_json(&serde_json::json!({ "page": "B5" })).is_err());
        assert!(PdfOptions::from_json(&serde_json::json!({ "marginMm": 80 })).is_err());
        let o = PdfOptions::from_json(
            &serde_json::json!({ "page": "A5", "orientation": "landscape", "marginMm": 10 }),
        )
        .unwrap();
        assert_eq!(
            (o.page.as_str(), o.landscape, o.margin_mm),
            ("A5", true, 10.0)
        );
    }
}
