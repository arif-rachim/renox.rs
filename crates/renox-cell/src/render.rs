//! Page rendering in the cell (ADR D7, path A; `docs/contracts/ops.md`
//! section 14, "Rendering"; `docs/contracts/errors.md` section 1, "Page
//! (HTML) routes").
//!
//! The isolate returns the loader's data as JSON ([`PageRender`]); the cell
//! parses it straight into `minijinja::Value` (`serde_json` with
//! `float_roundtrip`, no `serde_json::Value` in between: the B9 path) and
//! renders with `renox-template` on Tokio's blocking pool, outside the
//! isolate and its CPU limit. The render's thread CPU time and fuel are the
//! meter's `render_ms` and `render_fuel`.
//!
//! A slow loader's page gets its shell first (`ops.md` section 14,
//! "Streaming the shell", #161): [`PageRenderer::shell_of`] renders the
//! page with template data that records the first read, and the output
//! before that read is sent while the loader still runs.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http::{HeaderMap, Response};
use renox_runtime::manifest::{Manifest, TemplateKind};
use renox_runtime::pages::PageRender;
use renox_template::minijinja::Value;
use renox_template::minijinja::value::{Enumerator, Object, ObjectRepr};
use renox_template::{
    ErrorPage, RenderContext, RenderError, RenderLimits, RenderTarget, Renderer, Shell,
};

/// `RENOX_RENDER_LIMIT` (`errors.md` section 3).
pub const RENDER_LIMIT_CODE: &str = "RENOX_RENDER_LIMIT";
const RENDER_LIMIT_MESSAGE: &str = "The page could not be rendered.";
const INTERNAL_CODE: &str = "RENOX_INTERNAL";
const INTERNAL_MESSAGE: &str = "Internal error. Quote the request id when reporting it.";
const NOT_FOUND_MESSAGE: &str = "Page not found.";

/// The renderer of one deployment: built once per cell from the artifact's
/// `templates/` (artifact v1). `None` for an artifact without templates.
pub struct PageRenderer {
    renderer: Renderer,
    /// Page template id -> its fragment names.
    fragments: BTreeMap<String, BTreeSet<String>>,
    error_template: Option<String>,
    not_found_template: Option<String>,
    /// The app's UTC offset for the `date` filter.
    utc_offset_minutes: i32,
    /// The deployment's artifact hash, for `<meta name="renox-deployment">`.
    deployment: String,
    /// The client script's `src`; `None` when client events are off.
    client_script: Option<String>,
}

impl std::fmt::Debug for PageRenderer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PageRenderer")
            .field("pages", &self.fragments.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

/// UTC offsets of the zones the platform's first market uses (none has DST).
/// Other zones render dates in UTC until a time-zone database is added.
fn utc_offset_minutes(zone: &str) -> i32 {
    match zone {
        "Asia/Dubai" | "Asia/Muscat" => 240,
        "Asia/Riyadh" | "Asia/Qatar" | "Asia/Bahrain" | "Asia/Kuwait" => 180,
        _ => 0,
    }
}

/// The shell of a page (`ops.md` section 14, "Streaming the shell").
#[derive(Debug)]
pub struct PageShell {
    /// The bytes sent first: the page's output before its first read of
    /// the template data, cut back to the last complete tag, with the shell
    /// tags. The full page starts with exactly these bytes.
    pub html: String,
    pub fuel: u64,
    pub ms: f64,
    /// The render time of the shell: the full page renders with the same.
    pub now_ms: i64,
}

/// Template data that records its first read, for [`PageRenderer::shell_of`].
#[derive(Debug, Default)]
struct Probe(AtomicBool);

impl Object for Probe {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Map
    }

    fn get_value(self: &Arc<Self>, _key: &Value) -> Option<Value> {
        self.0.store(true, Ordering::SeqCst);
        None
    }

    fn enumerate(self: &Arc<Self>) -> Enumerator {
        self.0.store(true, Ordering::SeqCst);
        Enumerator::Empty
    }
}

/// Keeps the output written before the probe's first read, then refuses
/// more, which ends the render.
struct UntilRead {
    probe: Arc<Probe>,
    out: Vec<u8>,
}

impl Write for UntilRead {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.probe.0.load(Ordering::SeqCst) {
            return Err(io::Error::other("template data read"));
        }
        self.out.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// What one render produced: the response and what it used.
#[derive(Debug)]
pub struct Rendered {
    pub response: Response<Bytes>,
    pub fuel: u64,
    /// Thread CPU milliseconds; `None` when nothing was rendered.
    pub ms: Option<f64>,
    /// A render limit ended the request (meter `status: render_limit`).
    pub limit: bool,
    /// For the tenant log: `(message, fields)` of a failure.
    pub log: Option<(String, serde_json::Map<String, serde_json::Value>)>,
}

impl PageRenderer {
    /// Loads `templates/<id>.jinja` for every `manifest.templates` key (the
    /// runtime has checked V14). `Ok(None)` when there are no templates.
    ///
    /// `deployment` and `client_script` are what the page shell carries
    /// (`renox_template::shell`, #126).
    pub fn load(
        artifact_dir: &Path,
        manifest: &Manifest,
        deployment: &str,
        client_script: Option<String>,
    ) -> Result<Option<PageRenderer>, String> {
        let mut sources = Vec::new();
        let mut fragments = BTreeMap::new();
        let mut error_template = None;
        let mut not_found_template = None;
        for (id, def) in manifest.template_defs() {
            let path = artifact_dir.join("templates").join(format!("{id}.jinja"));
            let source = std::fs::read_to_string(&path)
                .map_err(|_| format!("V14: templates/{id}.jinja cannot be read as UTF-8"))?;
            sources.push((id.clone(), source));
            match def.kind {
                TemplateKind::Page => {
                    fragments.insert(
                        id.clone(),
                        def.fragments
                            .as_ref()
                            .map(|f| f.keys().cloned().collect())
                            .unwrap_or_default(),
                    );
                }
                TemplateKind::Error => error_template = Some(id.clone()),
                TemplateKind::NotFound => not_found_template = Some(id.clone()),
                TemplateKind::Layout | TemplateKind::Partial => {}
            }
        }
        if sources.is_empty() {
            return Ok(None);
        }
        let renderer = Renderer::new(sources.iter().map(|(i, s)| (i.as_str(), s.as_str())))
            .map_err(|e| format!("V14: {e}"))?;
        Ok(Some(PageRenderer {
            renderer,
            fragments,
            error_template,
            not_found_template,
            utc_offset_minutes: utc_offset_minutes(&manifest.app.timezone),
            deployment: deployment.to_string(),
            client_script,
        }))
    }

    /// The page shell tags of one response (`client-events.md` section 1).
    fn shell<'a>(
        &'a self,
        request_id: &'a str,
        csp_nonce: Option<&'a str>,
        error_code: Option<&'a str>,
    ) -> Shell<'a> {
        Shell {
            request_id,
            deployment: &self.deployment,
            nonce: csp_nonce,
            script_src: self.client_script.as_deref(),
            error_code,
        }
    }

    fn context(&self, csp_nonce: Option<&str>) -> RenderContext {
        RenderContext {
            csp_nonce: csp_nonce.map(str::to_string),
            csrf_token: None,
            now_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64,
            utc_offset_minutes: self.utc_offset_minutes,
            ..RenderContext::default()
        }
    }

    /// The shell of a full-page render of `template` (`ops.md` section 14,
    /// "Streaming the shell"), or `None` when it is empty: the template
    /// reads its data before writing a complete tag. Blocking: call on the
    /// render pool.
    pub fn shell_of(
        &self,
        template: &str,
        request_id: &str,
        csp_nonce: Option<&str>,
        csrf_token: Option<&str>,
    ) -> Option<PageShell> {
        let cx = RenderContext {
            csrf_token: csrf_token.map(str::to_string),
            ..self.context(csp_nonce)
        };
        let probe = Arc::new(Probe::default());
        let mut out = UntilRead {
            probe: probe.clone(),
            out: Vec::new(),
        };
        let stats = match self.renderer.render_to(
            RenderTarget::Page(template),
            Value::from_dyn_object(probe),
            &cx,
            &RenderLimits::DEFAULT,
            &mut out,
        ) {
            Ok(s) => s,
            Err(e) => e.stats(),
        };
        let html = String::from_utf8_lossy(&out.out);
        let cut = html.rfind('>')? + 1;
        let html = self.shell(request_id, csp_nonce, None).inject(&html[..cut]);
        Some(PageShell {
            html,
            fuel: stats.fuel_used,
            ms: stats.ms,
            now_ms: cx.now_ms,
        })
    }

    /// Renders a page request: the page, or the selected fragment, then any
    /// out-of-band fragments marked `hx-swap-oob="true"`. A failure is
    /// answered with the error page. Blocking: call on the render pool.
    pub fn render_page(
        &self,
        page: &PageRender,
        request_id: &str,
        csp_nonce: Option<&str>,
        csrf_token: Option<&str>,
        head: bool,
        now_ms: Option<i64>,
    ) -> Rendered {
        let Some(template) = page.template.as_deref() else {
            return self.failure(
                request_id,
                csp_nonce,
                Failure::internal("no_template", None),
                0,
                None,
            );
        };
        let data: Value = match serde_json::from_str(&page.data_json) {
            Ok(v) => v,
            Err(e) => {
                return self.failure(
                    request_id,
                    csp_nonce,
                    Failure::internal("data_not_serialisable", Some(e.to_string())),
                    0,
                    None,
                );
            }
        };
        let known = self.fragments.get(template);
        if let Some(unknown) = page
            .oob_fragments
            .iter()
            .find(|f| !known.is_some_and(|k| k.contains(*f)))
        {
            // ops.md section 14: a name not in the page's fragment map.
            return self.failure(
                request_id,
                csp_nonce,
                Failure::internal("unknown_fragment", Some(format!("fragment `{unknown}`"))),
                0,
                None,
            );
        }
        let mut cx = RenderContext {
            csrf_token: csrf_token.map(str::to_string),
            ..self.context(csp_nonce)
        };
        if let Some(now) = now_ms {
            cx.now_ms = now;
        }
        let limits = RenderLimits::DEFAULT;
        let main: Vec<&str> = page.fragment.as_deref().into_iter().collect();
        let result = if page.oob_fragments.is_empty() {
            let target = match page.fragment.as_deref() {
                Some(block) => RenderTarget::Fragment { template, block },
                None => RenderTarget::Page(template),
            };
            self.renderer
                .render(target, data, &cx, &limits)
                .map(|o| (o.html, o.fuel_used, o.ms))
        } else if main.is_empty() {
            // An htmx action with `{ fragments }` and no fragment selected by
            // `HX-Target`: only the out-of-band blocks.
            let blocks: Vec<&str> = page.oob_fragments.iter().map(String::as_str).collect();
            self.renderer
                .render_blocks(template, &blocks, data, &cx, &limits)
                .map(|(parts, stats)| {
                    let html: String = parts.iter().map(|p| mark_oob(p)).collect();
                    (html, stats.fuel_used, stats.ms)
                })
        } else {
            let mut blocks = main.clone();
            blocks.extend(page.oob_fragments.iter().map(String::as_str));
            self.renderer
                .render_blocks(template, &blocks, data, &cx, &limits)
                .map(|(parts, stats)| {
                    let mut html = String::new();
                    for (i, p) in parts.into_iter().enumerate() {
                        if i == 0 {
                            html.push_str(&p);
                        } else {
                            html.push_str(&mark_oob(&p));
                        }
                    }
                    (html, stats.fuel_used, stats.ms)
                })
        };
        match result {
            Ok((html, fuel, ms)) => Rendered {
                // A whole page gets the shell tags; fragments do not.
                response: html_response(
                    200,
                    request_id,
                    if head {
                        Bytes::new()
                    } else if page.fragment.is_none() && page.oob_fragments.is_empty() {
                        Bytes::from(self.shell(request_id, csp_nonce, None).inject(&html))
                    } else {
                        Bytes::from(html)
                    },
                ),
                fuel,
                ms: Some(ms),
                limit: false,
                log: None,
            },
            Err(e) => {
                let stats = e.stats();
                let failure = if e.is_limit() {
                    Failure::limit(template, &e)
                } else {
                    Failure::internal("render_failed", Some(e.to_string()))
                };
                self.failure(
                    request_id,
                    csp_nonce,
                    failure,
                    stats.fuel_used,
                    Some(stats.ms),
                )
            }
        }
    }

    fn failure(
        &self,
        request_id: &str,
        csp_nonce: Option<&str>,
        failure: Failure,
        fuel: u64,
        ms: Option<f64>,
    ) -> Rendered {
        let mut page = self.error_page(
            500,
            Some(failure.code),
            failure.message,
            request_id,
            csp_nonce,
        );
        page.fuel += fuel;
        page.ms = match (page.ms, ms) {
            (Some(a), Some(b)) => Some(a + b),
            (a, b) => a.or(b),
        };
        page.limit = failure.limit;
        page.log = Some((failure.log_message, failure.fields));
        page
    }

    /// The error page (`errors.md` section 1): the tenant's `pages/_error`
    /// with exactly `status`, `code`, `request_id`, `message`, under the
    /// fixed error-page budget; the platform default page when there is no
    /// error template or it fails.
    pub fn error_page(
        &self,
        status: u16,
        code: Option<&str>,
        message: &str,
        request_id: &str,
        csp_nonce: Option<&str>,
    ) -> Rendered {
        self.render_status_page(
            self.error_template.as_deref(),
            status,
            code,
            message,
            request_id,
            csp_nonce,
        )
    }

    /// The 404 page for a `GET`/`HEAD` that matched no route: `pages/_404`,
    /// then `pages/_error`, then the default page.
    pub fn not_found_page(&self, request_id: &str, csp_nonce: Option<&str>) -> Rendered {
        let template = self
            .not_found_template
            .as_deref()
            .or(self.error_template.as_deref());
        self.render_status_page(
            template,
            404,
            None,
            NOT_FOUND_MESSAGE,
            request_id,
            csp_nonce,
        )
    }

    fn render_status_page(
        &self,
        template: Option<&str>,
        status: u16,
        code: Option<&str>,
        message: &str,
        request_id: &str,
        csp_nonce: Option<&str>,
    ) -> Rendered {
        let input = ErrorPage {
            status,
            code,
            request_id,
            message,
        };
        let fallback = || {
            crate::pages::errors::default_page(input, Some(self.shell(request_id, csp_nonce, code)))
        };
        let Some(template) = template else {
            return Rendered {
                response: fallback(),
                fuel: 0,
                ms: None,
                limit: false,
                log: None,
            };
        };
        // Exactly the four fields (errors.md section 1).
        let data: Value = serde_json::from_value(input.data()).expect("plain JSON deserialises");
        match self.renderer.render(
            RenderTarget::Page(template),
            data,
            &self.context(csp_nonce),
            &RenderLimits::ERROR_PAGE,
        ) {
            Ok(out) => Rendered {
                response: html_response(
                    status,
                    request_id,
                    Bytes::from(self.shell(request_id, csp_nonce, code).inject(&out.html)),
                ),
                fuel: out.fuel_used,
                ms: Some(out.ms),
                limit: false,
                log: None,
            },
            Err(e) => {
                let stats = e.stats();
                let mut fields = serde_json::Map::new();
                fields.insert("code".into(), RENDER_LIMIT_CODE.into());
                fields.insert("template".into(), template.into());
                if let Some(l) = limit_name(&e) {
                    fields.insert("limit".into(), l.into());
                } else {
                    fields.insert("cause_message".into(), e.to_string().into());
                }
                Rendered {
                    response: fallback(),
                    fuel: stats.fuel_used,
                    ms: Some(stats.ms),
                    limit: false,
                    log: Some(("error page could not be rendered".into(), fields)),
                }
            }
        }
    }
}

/// Why a page render failed.
struct Failure {
    code: &'static str,
    message: &'static str,
    limit: bool,
    log_message: String,
    fields: serde_json::Map<String, serde_json::Value>,
}

impl Failure {
    fn internal(reason: &str, detail: Option<String>) -> Failure {
        let mut fields = serde_json::Map::new();
        fields.insert("code".into(), INTERNAL_CODE.into());
        fields.insert("phase".into(), "render".into());
        fields.insert("reason".into(), reason.into());
        if let Some(d) = detail {
            fields.insert("cause_message".into(), d.into());
        }
        Failure {
            code: INTERNAL_CODE,
            message: INTERNAL_MESSAGE,
            limit: false,
            log_message: "page could not be rendered".into(),
            fields,
        }
    }

    fn limit(template: &str, e: &RenderError) -> Failure {
        let mut fields = serde_json::Map::new();
        fields.insert("code".into(), RENDER_LIMIT_CODE.into());
        fields.insert("template".into(), template.into());
        fields.insert("limit".into(), limit_name(e).unwrap_or("fuel").into());
        fields.insert("render_fuel".into(), e.stats().fuel_used.into());
        Failure {
            code: RENDER_LIMIT_CODE,
            message: RENDER_LIMIT_MESSAGE,
            limit: true,
            log_message: "render limit reached".into(),
            fields,
        }
    }
}

/// The `limit` field of `RENOX_RENDER_LIMIT` (`errors.md` section 3).
fn limit_name(e: &RenderError) -> Option<&'static str> {
    Some(match e {
        RenderError::Fuel(_) => "fuel",
        RenderError::Iterations(_) => "iterations",
        RenderError::OutputSize(_) => "output",
        RenderError::Depth(_) => "depth",
        RenderError::Timeout(_) => "time",
        _ => return None,
    })
}

/// `hx-swap-oob="true"` on the first element of an out-of-band fragment
/// (`docs/09-htmx-realtime.md`).
pub fn mark_oob(html: &str) -> String {
    let Some(start) = html.find('<') else {
        return html.to_string();
    };
    let rest = &html[start + 1..];
    let name_len = rest
        .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
        .unwrap_or(rest.len());
    if name_len == 0 || !rest.as_bytes()[0].is_ascii_alphabetic() {
        return html.to_string();
    }
    let at = start + 1 + name_len;
    format!("{} hx-swap-oob=\"true\"{}", &html[..at], &html[at..])
}

/// A page response (`ops.md` section 14).
pub fn html_response(status: u16, request_id: &str, body: Bytes) -> Response<Bytes> {
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("vary", "HX-Request, HX-Target")
        .header("x-renox-request-id", request_id)
        .body(body)
        .expect("static response parts are valid")
}

/// The markup of an error page rendered inside a stream (`ops.md` section
/// 14, "Errors after the shell"): from its opening `<body>` tag on, all of
/// it when it has none.
pub fn from_body_tag(html: &[u8]) -> &[u8] {
    let mut from = 0;
    while let Some(i) = html[from..].iter().position(|&b| b == b'<') {
        let at = from + i;
        if html
            .get(at + 1..at + 5)
            .is_some_and(|n| n.eq_ignore_ascii_case(b"body"))
            && html
                .get(at + 5)
                .is_some_and(|c| *c == b'>' || *c == b'/' || c.is_ascii_whitespace())
        {
            return &html[at..];
        }
        from = at + 1;
    }
    html
}

/// The platform default page (`errors.md` section 1) without shell tags,
/// for paths that have no renderer: see [`crate::pages::errors`].
pub fn default_page(status: u16, message: &str, request_id: &str) -> Response<Bytes> {
    crate::pages::errors::default_page(
        ErrorPage {
            status,
            code: None,
            request_id,
            message,
        },
        None,
    )
}

/// Whether `Accept` ranks `text/html` above `application/json` (the 404 page
/// rule of `errors.md` section 1).
pub fn prefers_html(headers: &HeaderMap) -> bool {
    let mut html = 0.0f32;
    let mut json = 0.0f32;
    for value in headers.get_all(http::header::ACCEPT) {
        let Ok(value) = value.to_str() else { continue };
        for item in value.split(',') {
            let mut parts = item.split(';');
            let media = parts.next().unwrap_or("").trim().to_ascii_lowercase();
            let q = parts
                .filter_map(|p| p.trim().strip_prefix("q="))
                .find_map(|q| q.parse::<f32>().ok())
                .unwrap_or(1.0);
            match media.as_str() {
                "text/html" => html = html.max(q),
                "application/json" => json = json.max(q),
                _ => {}
            }
        }
    }
    html > json
}

/// The status and code of a platform JSON error (`errors.md` section 1).
pub fn platform_error(response: &Response<Bytes>) -> Option<(u16, String, String)> {
    let v: serde_json::Value = serde_json::from_slice(response.body()).ok()?;
    let e = v.get("error")?;
    Some((
        response.status().as_u16(),
        e.get("code")?.as_str()?.to_string(),
        e.get("message")?.as_str()?.to_string(),
    ))
}

/// A shared renderer.
pub type SharedPages = Arc<PageRenderer>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oob_marker_goes_on_the_first_element() {
        assert_eq!(
            mark_oob("<span id=\"cart-badge\">2</span>"),
            "<span hx-swap-oob=\"true\" id=\"cart-badge\">2</span>"
        );
        assert_eq!(
            mark_oob("\n<li>x</li>"),
            "\n<li hx-swap-oob=\"true\">x</li>"
        );
        assert_eq!(mark_oob("text only"), "text only");
    }

    #[test]
    fn accept_header_preference() {
        let mut h = HeaderMap::new();
        h.insert(
            "accept",
            "text/html,application/xhtml+xml,*/*;q=0.8".parse().unwrap(),
        );
        assert!(prefers_html(&h));
        h.insert(
            "accept",
            "application/json, text/html;q=0.5".parse().unwrap(),
        );
        assert!(!prefers_html(&h));
        assert!(!prefers_html(&HeaderMap::new()));
    }

    #[test]
    fn error_markup_starts_at_the_body_tag() {
        assert_eq!(
            from_body_tag(
                b"<html><head><title>x</title></head><body class=\"e\"><h1>500</h1></body></html>"
            ),
            b"<body class=\"e\"><h1>500</h1></body></html>"
        );
        assert_eq!(from_body_tag(b"<BODY>x"), b"<BODY>x");
        assert_eq!(
            from_body_tag(b"<bodyguard>x</bodyguard>"),
            b"<bodyguard>x</bodyguard>"
        );
        assert_eq!(from_body_tag(b"<p>no body</p>"), b"<p>no body</p>");
    }

    #[test]
    fn gulf_offsets() {
        assert_eq!(utc_offset_minutes("Asia/Dubai"), 240);
        assert_eq!(utc_offset_minutes("Asia/Riyadh"), 180);
        assert_eq!(utc_offset_minutes("Europe/Paris"), 0);
    }
}
