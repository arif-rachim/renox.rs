//! `ctx.pdf` (`docs/contracts/ops.md` 1.7.0 section 24; #322): a template
//! the cell renders to HTML, laid out and written as PDF in Rust.
//!
//! | Step | Here |
//! | --- | --- |
//! | Template → HTML | the cell's renderer, through [`TemplateHost`] (the renderer never runs tenant code) |
//! | HTML → document | [`to_typst`]: the HTML subset of invoices and reports (headings, paragraphs, `strong`/`em`, `br`, lists, tables, `hr`) as typst code; `<html dir lang>` sets the direction and language |
//! | Layout and shaping | `typst` (rustybuzz shaping, Unicode bidi), with the bundled Noto Sans and Noto Naskh Arabic only: no system fonts, no remote resources |
//! | PDF | `typst-pdf` |
//! | Images | `<img src>` of a tenant file (`/_img/<key>?w=`, through [`PdfImages`]) or a `data:image/png|jpeg;base64,` URI, served to typst under synthetic paths `/img/<n>.<ext>` only the converted document names (1.13.0, #582) |
//! | Limits | 200 pages and 20 MB of output (*proposed*); 50 images, 2 MiB per data URI, 20 MB of image bytes: `RENOX_PDF_LIMIT` |
//!
//! Every text node becomes a typst string literal, so template data can
//! never be read as typst markup or code.
//!
//! The layout engine is the Cargo feature `pdf` (on by default; #372). A
//! worker built without it keeps `ctx.pdf` and its option checks but answers
//! every render with `RENOX_INTERNAL`, `reason: "pdf_unavailable"`.

use std::sync::Arc;

/// Output limits (*proposed*, ops.md section 24).
pub const MAX_PAGES: usize = 200;
pub const MAX_BYTES: usize = 20 * 1024 * 1024;
/// Image limits (ops.md 1.13.0 section 24): images per document, decoded
/// bytes of one data URI, image bytes per document, and the widest variant
/// asked of the store.
pub const MAX_IMAGES: usize = 50;
pub const MAX_DATA_IMAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_IMAGE_WIDTH: u32 = 1600;

/// The format of an image embedded in a PDF.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
}

impl ImageFormat {
    /// The extension of its synthetic path (`/img/<n>.<ext>`).
    pub fn ext(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
        }
    }

    /// The format whose signature `bytes` start with.
    pub fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(ImageFormat::Png)
        } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(ImageFormat::Jpeg)
        } else {
            None
        }
    }
}

/// Why a tenant image did not come through; the `<img>` is then dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageError {
    /// No stored file has this key (or it belongs to another tenant).
    NotFound,
    /// The file is not an image the renderer embeds.
    Unsupported,
    /// The store or the transform failed (the cause, for the log).
    Failed(String),
}

/// The cell's image pipeline for `ctx.pdf` (ops.md 1.13.0 section 24, #582):
/// `/_img/<key>?w=<n>` of the deployment's tenant as JPEG or PNG bytes.
/// `width` is the asked width, at most [`MAX_IMAGE_WIDTH`] (`None`: no `w`).
/// A private key needs no signature: the render runs as the tenant.
/// Blocking (called on the blocking pool).
pub trait PdfImages: Send + Sync {
    fn read_image(
        &self,
        key: &str,
        width: Option<u32>,
    ) -> Result<(Vec<u8>, ImageFormat), ImageError>;
}

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
    /// This worker was built without the `pdf` feature.
    Unavailable,
}

/// The cell's renderer: a page or partial template of the deployment with
/// its data, as HTML.
pub trait TemplateHost: Send + Sync {
    fn render(&self, template: &str, data_json: &str) -> Result<String, String>;

    /// `ctx.render` (`ops.md` section 25): a page or partial of the
    /// deployment as a fragment, in the request's `locale` and `dir` (empty
    /// strings: `en` and the locale's default). `principal` is the request's
    /// (`None`: anonymous or no tenant code ran), which answers `r-can`.
    /// `(html, fuel, ms)`. Blocking.
    /// The default knows no template, so a host without it answers
    /// [`TemplateError::Unknown`].
    fn render_fragment(
        &self,
        template: &str,
        data_json: &str,
        locale: &str,
        dir: &str,
        principal: Option<Arc<renox_authz::Principal>>,
    ) -> Result<(String, u64, f64), TemplateError> {
        let _ = (template, data_json, locale, dir, principal);
        Err(TemplateError::Unknown)
    }

    /// The tenant's `/_img` keys for `ctx.pdf` (#582). The default has none:
    /// a `/_img` image is dropped, data URIs still render.
    fn images(&self) -> Option<Arc<dyn PdfImages>> {
        None
    }
}

/// Why `ctx.render` failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    /// Not a template of the deployment.
    Unknown,
    /// A render limit (`fuel`, `iterations`, ...): `RENOX_RENDER_LIMIT`.
    Limit(&'static str),
    /// The render failed (the cause, for the tenant log).
    Failed(String),
}

/// What the cell gives an [`crate::IsolateSpec`].
#[derive(Clone)]
pub struct TemplateSlot(pub Arc<dyn TemplateHost>);

impl std::fmt::Debug for TemplateSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TemplateSlot")
    }
}

#[cfg(feature = "pdf")]
pub use engine::{html_to_pdf, html_to_pdf_with, layout, layout_with, text_runs, to_typst};

/// The layout engine: typst with the bundled fonts, and the HTML reader.
#[cfg(feature = "pdf")]
mod engine {
    use std::collections::HashMap;
    use std::sync::OnceLock;

    use base64::Engine as _;
    use html5ever::tendril::TendrilSink;
    use markup5ever_rcdom::{Handle, NodeData, RcDom};
    use typst::diag::{FileError, FileResult};
    use typst::foundations::{Bytes, Datetime};
    use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
    use typst::text::{Font, FontBook};
    use typst::utils::LazyHash;
    use typst::{Library, LibraryExt, World};

    use super::{
        ImageError, ImageFormat, MAX_BYTES, MAX_DATA_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_WIDTH,
        MAX_IMAGES, MAX_PAGES, PdfError, PdfImages, PdfOptions,
    };

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
        /// The images of this document under their synthetic paths: the
        /// only files the World serves.
        files: HashMap<FileId, Bytes>,
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
        fn file(&self, id: FileId) -> FileResult<Bytes> {
            // The document's own images (#582); no includes, no remote resources.
            self.files.get(&id).cloned().ok_or(FileError::AccessDenied)
        }
        fn font(&self, index: usize) -> Option<Font> {
            shared().fonts.get(index).cloned()
        }
        fn today(&self, _offset: Option<typst::foundations::Duration>) -> Option<Datetime> {
            None
        }
    }

    // ---------------------------------------------------------------------------
    // Images (ops.md 1.13.0 section 24, #582).

    /// Standard base64, padded or not.
    const B64: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );

    /// What an `<img src>` names.
    enum Src {
        /// `data:image/png|jpeg;base64,`: the base64 payload.
        Data(String),
        /// `/_img/<key>?w=<n>`.
        Key(String, Option<u32>),
    }

    /// The `src` the renderer embeds; `None` is dropped (`https:`, other
    /// `data:` types, relative paths, ...).
    fn classify(src: &str) -> Option<Src> {
        let src = src.trim();
        for prefix in ["data:image/png;base64,", "data:image/jpeg;base64,"] {
            if src.len() > prefix.len()
                && src.is_char_boundary(prefix.len())
                && src[..prefix.len()].eq_ignore_ascii_case(prefix)
            {
                let payload: String = src[prefix.len()..]
                    .chars()
                    .filter(|c| !c.is_ascii_whitespace())
                    .collect();
                return Some(Src::Data(payload));
            }
        }
        let rest = src.strip_prefix("/_img/")?;
        let (key, query) = rest.split_once('?').unwrap_or((rest, ""));
        let key_ok = !key.is_empty()
            && key.len() <= 256
            && !key.contains("..")
            && key.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'/' | b'_' | b'.' | b'-')
            });
        if !key_ok {
            return None;
        }
        let width = query
            .split('&')
            .filter_map(|p| p.split_once('='))
            .find(|(k, _)| *k == "w")
            .and_then(|(_, v)| v.parse::<u32>().ok())
            .map(|w| w.clamp(1, MAX_IMAGE_WIDTH));
        Some(Src::Key(key.to_string(), width))
    }

    /// One embedded image: its synthetic path and the `<img>`'s printed width.
    struct Placed {
        path: String,
        width_pt: Option<f64>,
        alt: Option<String>,
    }

    /// The images of one document, by `<img>` node.
    #[derive(Default)]
    struct Images {
        placed: HashMap<*const markup5ever_rcdom::Node, Placed>,
        files: HashMap<FileId, Bytes>,
    }

    fn collect(node: &Handle, out: &mut Vec<(Handle, Src)>) {
        for child in node.children.borrow().iter() {
            match tag(child).as_deref() {
                Some("script" | "style" | "head" | "template") => {}
                Some("img") => {
                    if let Some(src) = attr(child, "src").as_deref().and_then(classify) {
                        out.push((child.clone(), src));
                    }
                }
                Some(_) => collect(child, out),
                None => {}
            }
        }
    }

    /// Finds, checks and reads the images under `body`; every limit is
    /// checked before layout.
    fn gather(body: &Handle, host: Option<&dyn PdfImages>) -> Result<Images, PdfError> {
        let mut found = Vec::new();
        collect(body, &mut found);
        if found.len() > MAX_IMAGES {
            return Err(PdfError::Limit(format!(
                "{} images, at most {MAX_IMAGES}",
                found.len()
            )));
        }
        // A data URI over the limit is refused before it is decoded.
        for (_, src) in &found {
            if let Src::Data(b64) = src
                && b64.len() / 4 * 3 > MAX_DATA_IMAGE_BYTES + 3
            {
                return Err(PdfError::Limit(format!(
                    "a data URI image of about {} bytes, at most {MAX_DATA_IMAGE_BYTES}",
                    b64.len() / 4 * 3
                )));
            }
        }
        let mut images = Images::default();
        let mut total = 0usize;
        for (node, src) in found {
            let got = match src {
                Src::Data(b64) => B64.decode(b64.as_bytes()).ok().and_then(|bytes| {
                    if bytes.len() > MAX_DATA_IMAGE_BYTES {
                        return Some(Err(bytes.len()));
                    }
                    ImageFormat::sniff(&bytes).map(|f| Ok((bytes, f)))
                }),
                Src::Key(key, width) => match host.map(|h| h.read_image(&key, width)) {
                    Some(Ok((bytes, format))) if ImageFormat::sniff(&bytes) == Some(format) => {
                        Some(Ok((bytes, format)))
                    }
                    Some(Err(ImageError::Failed(m))) => {
                        tracing::warn!(error = %m, "pdf image not read");
                        None
                    }
                    _ => None,
                },
            };
            let (bytes, format) = match got {
                None => continue,
                Some(Err(n)) => {
                    return Err(PdfError::Limit(format!(
                        "a data URI image of {n} bytes, at most {MAX_DATA_IMAGE_BYTES}"
                    )));
                }
                Some(Ok(x)) => x,
            };
            total += bytes.len();
            if total > MAX_IMAGE_BYTES {
                return Err(PdfError::Limit(format!(
                    "{total} bytes of images, at most {MAX_IMAGE_BYTES}"
                )));
            }
            let path = format!("/img/{}.{}", images.placed.len(), format.ext());
            let id = RootedPath::new(
                VirtualRoot::Project,
                VirtualPath::new(&path).map_err(|e| PdfError::Render(format!("{e:?}")))?,
            )
            .intern();
            images.files.insert(id, Bytes::new(bytes));
            // `width` in CSS pixels (1px = 0.75pt), as a browser prints it.
            let width_pt = attr(&node, "width")
                .and_then(|w| w.trim().trim_end_matches("px").parse::<f64>().ok())
                .filter(|w| w.is_finite() && *w > 0.0)
                .map(|w| (w.min(10_000.0) * 0.75 * 100.0).round() / 100.0);
            images.placed.insert(
                std::rc::Rc::as_ptr(&node),
                Placed {
                    path,
                    width_pt,
                    alt: attr(&node, "alt"),
                },
            );
        }
        Ok(images)
    }

    /// The typst call of one placed image: never wider than its column.
    fn image_call(p: &Placed) -> String {
        let alt = p
            .alt
            .as_deref()
            .map(|a| format!(", alt: {}", string_lit(a)))
            .unwrap_or_default();
        match p.width_pt {
            Some(w) => format!(
                "layout(size => image({}, width: calc.min(size.width, {w}pt){alt}))",
                string_lit(&p.path)
            ),
            None => format!("image({}{alt})", string_lit(&p.path)),
        }
    }

    // ---------------------------------------------------------------------------
    // HTML -> typst code.

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
    fn inline(node: &Handle, cx: &Images, out: &mut String) {
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
                    Some("img") => {
                        if let Some(p) = cx.placed.get(&std::rc::Rc::as_ptr(child)) {
                            out.push_str(&format!("#box({})", image_call(p)));
                        }
                    }
                    Some("strong" | "b" | "th") => {
                        out.push_str("#strong[");
                        inline(child, cx, out);
                        out.push(']');
                    }
                    Some("em" | "i") => {
                        out.push_str("#emph[");
                        inline(child, cx, out);
                        out.push(']');
                    }
                    Some("script" | "style" | "head" | "template") => {}
                    _ => inline(child, cx, out),
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
    fn blocks(node: &Handle, cx: &Images, out: &mut String) {
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
                            inline(child, cx, out);
                            out.push_str("]\n");
                        }
                        "p" => {
                            out.push_str("#par[");
                            inline(child, cx, out);
                            out.push_str("]\n");
                        }
                        "hr" => out.push_str("#line(length: 100%)\n"),
                        "img" => {
                            if let Some(p) = cx.placed.get(&std::rc::Rc::as_ptr(child)) {
                                out.push_str(&format!("#{}\n", image_call(p)));
                            }
                        }
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
                                inline(li, cx, out);
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
                                            inline(c, cx, out);
                                            out.push(']');
                                        } else {
                                            inline(c, cx, out);
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
                            inline(child, cx, out);
                            out.push_str("]\n");
                        }
                        // div, section, article, body, header, footer, main, …
                        _ => {
                            let dir = attr(child, "dir");
                            if let Some(d) = dir.as_deref().filter(|d| *d == "rtl" || *d == "ltr") {
                                out.push_str(&format!("#[#set text(dir: {d})\n"));
                                blocks(child, cx, out);
                                out.push_str("]\n");
                            } else {
                                blocks(child, cx, out);
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

    /// The typst source of an HTML document or fragment (no image is read:
    /// every `<img>` is dropped).
    pub fn to_typst(html: &str, options: &PdfOptions) -> String {
        let dom = html5ever::parse_document(RcDom::default(), Default::default()).one(html);
        typst_of(&dom.document, options, &Images::default())
    }

    fn parse(html: &str) -> Handle {
        html5ever::parse_document(RcDom::default(), Default::default())
            .one(html)
            .document
    }

    fn body_of(root: &Handle) -> Handle {
        find(root, "body").unwrap_or_else(|| root.clone())
    }

    fn typst_of(root: &Handle, options: &PdfOptions, cx: &Images) -> String {
        let root = root.clone();
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
        blocks(&body_of(&root), cx, &mut out);
        out
    }

    /// Lays `html` out with no image host (data URIs still render); the
    /// document, for the PDF writer and the tests.
    pub fn layout(
        html: &str,
        options: &PdfOptions,
    ) -> Result<typst_layout::PagedDocument, PdfError> {
        layout_with(html, options, None)
    }

    /// Lays `html` out, reading `/_img` keys through `images`.
    pub fn layout_with(
        html: &str,
        options: &PdfOptions,
        images: Option<&dyn PdfImages>,
    ) -> Result<typst_layout::PagedDocument, PdfError> {
        let root = parse(html);
        let cx = gather(&body_of(&root), images)?;
        let main = Source::detached(typst_of(&root, options, &cx));
        let world = Doc {
            main,
            files: cx.files,
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

    /// HTML to PDF bytes, with no image host (data URIs still render).
    pub fn html_to_pdf(html: &str, options: &PdfOptions) -> Result<Vec<u8>, PdfError> {
        html_to_pdf_with(html, options, None)
    }

    /// HTML to PDF bytes, reading `/_img` keys through `images`.
    pub fn html_to_pdf_with(
        html: &str,
        options: &PdfOptions,
        images: Option<&dyn PdfImages>,
    ) -> Result<Vec<u8>, PdfError> {
        let doc = layout_with(html, options, images)?;
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

    /// The renderer of one isolate's `ctx.pdf` and `ctx.render`.
    pub struct TemplateEnv {
        pub templates: Option<Arc<dyn TemplateHost>>,
    }

    /// `op_render_pdf(token, template, dataJson, optionsJson, module)`: the PDF bytes.
    #[op2]
    #[buffer]
    pub(crate) async fn op_render_pdf(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] template: String,
        #[string] data_json: String,
        #[string] options_json: String,
        #[string] module: Option<String>,
    ) -> Result<Vec<u8>, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let template = crate::ops::render::template_id(&template, module.as_deref())
            .map_err(|m| JsErrorBox::type_error(format!("pdf.render: {m}")))?;
        let host = state.borrow().borrow::<Rc<TemplateEnv>>().templates.clone();
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
        #[cfg(feature = "pdf")]
        let out = tokio::task::spawn_blocking(move || {
            let html = host
                .render(&template, &data_json)
                .map_err(PdfError::Render)?;
            let images = host.images();
            html_to_pdf_with(&html, &options, images.as_deref())
        })
        .await
        .map_err(|_| {
            op_error(
                "RENOX_INTERNAL",
                serde_json::Value::Null,
                "The PDF render failed.",
            )
        })?;
        // Built without the engine (#372): the template is not rendered either.
        #[cfg(not(feature = "pdf"))]
        let out: Result<Vec<u8>, PdfError> = {
            let _ = (host, template, data_json, options);
            Err(PdfError::Unavailable)
        };
        request.borrow_mut().render_pdf_ms += started.elapsed().as_secs_f64() * 1000.0;
        match out {
            Ok(bytes) => Ok(bytes),
            Err(PdfError::Unavailable) => Err(op_error(
                "RENOX_INTERNAL",
                serde_json::json!({ "reason": "pdf_unavailable" }),
                "PDF rendering is not available on this worker.",
            )),
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

    #[cfg(feature = "pdf")]
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
