//! The request-time renderer and its limits (`docs/08-template-engine.md`,
//! "Optimizations and limits"; `docs/04-isolation-security.md`, "Template
//! DoS").
//!
//! Every render runs under [`RenderLimits`], enforced here in Rust:
//!
//! | Limit | How |
//! | --- | --- |
//! | Fuel | minijinja's fuel: every instruction costs fuel |
//! | Iterations | every `r-for` goes through the `__loop` filter, which adds the list's length to a per-render counter |
//! | Output size | the output writer refuses bytes past the limit |
//! | Include depth | the longest `extends`/`include` chain of the target, computed when the renderer is built (a cycle is infinite) |
//! | Render time | checked against a deadline at every output write and every loop start |
//!
//! [`RenderOutput::fuel_used`] and [`RenderOutput::ms`] (thread CPU time)
//! are the meter's `render_fuel` and `render_ms` (`docs/contracts/meter.md`).

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use minijinja::value::{Enumerator, Object, ObjectRepr, Value, ValueKind};
use minijinja::{AutoEscape, Environment, Error, ErrorKind, State, UndefinedBehavior};

use crate::PLATFORM_VAR;
use crate::filters;

/// The render limits. Not overridable per app (`artifact.md`, "Limits
/// overrides"); the error page has its own fixed budget
/// ([`RenderLimits::ERROR_PAGE`], `docs/contracts/errors.md` section 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderLimits {
    /// minijinja fuel units.
    pub fuel: u64,
    /// Total items iterated by all loops of one render.
    pub max_iterations: u64,
    /// Bytes of HTML.
    pub max_output_bytes: usize,
    /// Longest `extends`/`include` chain (a page with a layout is 1).
    pub max_depth: usize,
    /// Wall-clock time of the render.
    pub timeout: Duration,
}

impl RenderLimits {
    /// Platform default for pages and fragments. *Proposed* values: the
    /// shop list page (100 products, about 25 KB) uses about 2% of the fuel
    /// (README, "Limits"); B13 stops at fuel well within 50 ms.
    pub const DEFAULT: RenderLimits = RenderLimits {
        fuel: 250_000,
        max_iterations: 100_000,
        max_output_bytes: 4 * 1024 * 1024,
        max_depth: 8,
        timeout: Duration::from_millis(200),
    };

    /// The fixed error-page budget of `docs/contracts/errors.md` section 1.
    pub const ERROR_PAGE: RenderLimits = RenderLimits {
        fuel: 10_000,
        max_iterations: 1_000,
        max_output_bytes: 64 * 1024,
        max_depth: 4,
        timeout: Duration::from_millis(10),
    };
}

impl Default for RenderLimits {
    fn default() -> Self {
        RenderLimits::DEFAULT
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    En,
    Ar,
}

/// The two platform locales, `en-AE` and `ar-AE`, with optional Eastern
/// Arabic digits (`ar-AE-u-nu-arab`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Locale {
    pub lang: Lang,
    pub arabic_digits: bool,
}

impl Locale {
    pub const EN_AE: Locale = Locale {
        lang: Lang::En,
        arabic_digits: false,
    };
    pub const AR_AE: Locale = Locale {
        lang: Lang::Ar,
        arabic_digits: false,
    };
    pub const AR_AE_ARABIC_DIGITS: Locale = Locale {
        lang: Lang::Ar,
        arabic_digits: true,
    };

    /// Parses a BCP 47 tag: `ar*` is Arabic, anything else English;
    /// `-u-nu-arab` selects Eastern Arabic digits.
    pub fn parse(tag: &str) -> Locale {
        let lower = tag.to_ascii_lowercase();
        let lang = if lower == "ar" || lower.starts_with("ar-") {
            Lang::Ar
        } else {
            Lang::En
        };
        Locale {
            lang,
            arabic_digits: lower.contains("-u-nu-arab"),
        }
    }
}

/// `can(action, resource)` for `r-can` / `r-cannot`.
pub type CanFn = dyn Fn(&str, &Value) -> bool + Send + Sync;

/// Per-request values the cell provides. Tenant data cannot set them.
#[derive(Clone, Default)]
pub struct RenderContext {
    pub locale: Locale,
    /// The per-request CSP nonce, added to every `<script>` and `<style>`.
    pub csp_nonce: Option<String>,
    /// The request's CSRF token for `<x-form>` and `<x-csrf>` (#41).
    pub csrf_token: Option<String>,
    /// "Now" for `ago`, Unix milliseconds.
    pub now_ms: i64,
    /// The app's UTC offset for `date` (Asia/Dubai: 240).
    pub utc_offset_minutes: i32,
    /// The permission check; `None` denies every `r-can`.
    pub can: Option<Arc<CanFn>>,
}

impl fmt::Debug for RenderContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RenderContext")
            .field("locale", &self.locale)
            .field("csp_nonce", &self.csp_nonce.as_ref().map(|_| "<set>"))
            .field("csrf_token", &self.csrf_token.as_ref().map(|_| "<set>"))
            .field("now_ms", &self.now_ms)
            .field("utc_offset_minutes", &self.utc_offset_minutes)
            .field("can", &self.can.is_some())
            .finish()
    }
}

/// What to render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderTarget<'a> {
    /// The whole template (with its layout).
    Page(&'a str),
    /// One block of a template (a fragment), without the layout.
    Fragment { template: &'a str, block: &'a str },
}

impl RenderTarget<'_> {
    pub fn template(&self) -> &str {
        match self {
            RenderTarget::Page(t) | RenderTarget::Fragment { template: t, .. } => t,
        }
    }
}

/// Usage of one render, for the meter.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RenderStats {
    /// Fuel consumed. On a limit other than fuel it is the fuel seen at the
    /// last loop start, a lower bound.
    pub fuel_used: u64,
    /// Thread CPU milliseconds of the render (meter `render_ms`).
    pub ms: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RenderOutput {
    pub html: String,
    pub fuel_used: u64,
    pub ms: f64,
}

/// Why a render failed. The limit variants map to `RENOX_RENDER_LIMIT`
/// (meter `status: render_limit`); `stats` holds what was used up to the stop.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum RenderError {
    #[error("render ran out of fuel")]
    Fuel(RenderStats),
    #[error("render iterated over more items than allowed")]
    Iterations(RenderStats),
    #[error("render output exceeded the size limit")]
    OutputSize(RenderStats),
    #[error("template include/extends depth exceeds the limit")]
    Depth(RenderStats),
    #[error("render exceeded its time limit")]
    Timeout(RenderStats),
    #[error("unknown template or fragment: {0}")]
    NotFound(String),
    /// A template error at run time (a filter given the wrong type, data
    /// that is not an object). The message is for the tenant log.
    #[error("template error: {message}")]
    Failed { message: String, stats: RenderStats },
}

impl RenderError {
    pub fn stats(&self) -> RenderStats {
        match self {
            RenderError::Fuel(s)
            | RenderError::Iterations(s)
            | RenderError::OutputSize(s)
            | RenderError::Depth(s)
            | RenderError::Timeout(s)
            | RenderError::Failed { stats: s, .. } => *s,
            RenderError::NotFound(_) => RenderStats::default(),
        }
    }

    /// True for the limits (`RENOX_RENDER_LIMIT`).
    pub fn is_limit(&self) -> bool {
        matches!(
            self,
            RenderError::Fuel(_)
                | RenderError::Iterations(_)
                | RenderError::OutputSize(_)
                | RenderError::Depth(_)
                | RenderError::Timeout(_)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Iterations,
    OutputSize,
    Timeout,
}

/// The platform value `__renox`: what the compiler-emitted code and the
/// filters read. Lives outside tenant data.
pub struct Scope {
    pub locale: Locale,
    pub csp_nonce: Option<String>,
    pub csrf_token: Option<String>,
    pub now_ms: i64,
    pub utc_offset_minutes: i32,
    can: Option<Arc<CanFn>>,
    max_iterations: u64,
    iterations: AtomicU64,
    deadline: Instant,
    fuel_seen: AtomicU64,
    stop: Mutex<Option<Stop>>,
}

impl fmt::Debug for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Scope")
            .field("locale", &self.locale)
            .field("now_ms", &self.now_ms)
            .finish_non_exhaustive()
    }
}

impl Scope {
    fn stop(&self, why: Stop) {
        let mut s = self.stop.lock().expect("stop lock");
        s.get_or_insert(why);
    }
}

impl Object for Scope {
    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        match key.as_str()? {
            "csp_nonce" => Some(Value::from(self.csp_nonce.clone())),
            "csrf_token" => Some(Value::from(self.csrf_token.clone())),
            _ => None,
        }
    }

    fn enumerate(self: &Arc<Self>) -> Enumerator {
        Enumerator::Str(&["csp_nonce", "csrf_token"])
    }
}

/// The scope of the render a filter runs in.
pub fn scope_of(state: &State) -> Option<Arc<Scope>> {
    state.lookup(PLATFORM_VAR)?.downcast_object::<Scope>()
}

/// The root context: `__renox` first, then the tenant's data. A data key
/// named `__renox` cannot replace the platform value.
#[derive(Debug)]
struct Root {
    scope: Value,
    data: Value,
}

impl Object for Root {
    fn repr(self: &Arc<Self>) -> ObjectRepr {
        ObjectRepr::Map
    }

    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        if key.as_str() == Some(PLATFORM_VAR) {
            return Some(self.scope.clone());
        }
        self.data.get_item(key).ok().filter(|v| !v.is_undefined())
    }

    fn enumerate(self: &Arc<Self>) -> Enumerator {
        match self.data.try_iter() {
            Ok(iter) => Enumerator::Values(iter.collect()),
            Err(_) => Enumerator::Empty,
        }
    }
}

/// `{% for x in (list) | __loop %}`: counts iterations, checks the deadline.
fn loop_guard(state: &State, value: Value) -> Result<Value, Error> {
    let Some(scope) = scope_of(state) else {
        return Ok(value);
    };
    if let Some((consumed, _)) = state.fuel_levels() {
        scope.fuel_seen.store(consumed, Ordering::Relaxed);
    }
    if Instant::now() >= scope.deadline {
        scope.stop(Stop::Timeout);
        return Err(Error::new(ErrorKind::InvalidOperation, "render time limit"));
    }
    let n = match value.len() {
        Some(n) => n as u64,
        None if value.is_undefined() || value.is_none() => 0,
        None => value.try_iter().map(|i| i.count() as u64).unwrap_or(0),
    };
    let total = scope.iterations.fetch_add(n, Ordering::Relaxed) + n;
    if total > scope.max_iterations {
        scope.stop(Stop::Iterations);
        return Err(Error::new(
            ErrorKind::InvalidOperation,
            "render iteration limit",
        ));
    }
    Ok(value)
}

/// `can(action, resource)`, emitted by the compiler for `r-can`.
fn can(state: &State, action: &str, resource: Value) -> bool {
    scope_of(state)
        .and_then(|s| s.can.clone())
        .is_some_and(|f| f(action, &resource))
}

/// Writes into the caller's sink, refusing bytes past the output limit and
/// any write after the deadline.
struct LimitedWriter<'w> {
    inner: &'w mut dyn Write,
    written: usize,
    max: usize,
    deadline: Instant,
    stop: Option<Stop>,
}

impl Write for LimitedWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written + buf.len() > self.max {
            self.stop = Some(Stop::OutputSize);
            return Err(io::Error::other("render output limit"));
        }
        if Instant::now() >= self.deadline {
            self.stop = Some(Stop::Timeout);
            return Err(io::Error::other("render time limit"));
        }
        self.written += buf.len();
        self.inner.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Renders compiled templates. Built once per deployment; shared across
/// render threads.
pub struct Renderer {
    /// Environments by fuel budget (minijinja's fuel is per environment).
    envs: Mutex<HashMap<u64, Arc<Environment<'static>>>>,
    base: Environment<'static>,
    /// Longest extends/include chain per template; `usize::MAX` for a cycle.
    depth: BTreeMap<String, usize>,
}

impl fmt::Debug for Renderer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Renderer")
            .field("templates", &self.depth.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// `{% extends "x" %}` and `{% include "x" %}` targets in emitted source.
fn references(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    for kw in ["{% extends ", "{% include "] {
        let mut rest = source;
        while let Some(i) = rest.find(kw) {
            rest = &rest[i + kw.len()..];
            if let Some(end) = rest.find(" %}")
                && let Ok(name) = serde_json::from_str::<String>(&rest[..end])
            {
                out.push(name);
            }
        }
    }
    out
}

/// Writes a value into the HTML output: `undefined` and `none` (JS
/// `null`) print nothing, safe strings print as they are, everything else
/// is escaped. Unlike minijinja's default, `/` is not escaped: it is not
/// special in HTML text or quoted attributes, and URLs and dates stay short.
fn format_value(
    out: &mut minijinja::Output,
    _state: &mut State,
    value: &Value,
) -> Result<(), Error> {
    if value.is_undefined() || value.is_none() {
        return Ok(());
    }
    let text = value.to_string();
    let write = |out: &mut minijinja::Output, s: &str| {
        out.write_str(s)
            .map_err(|e| Error::new(ErrorKind::WriteFailure, e.to_string()))
    };
    if value.is_safe() {
        return write(out, &text);
    }
    let mut last = 0;
    for (i, c) in text.char_indices() {
        let rep = match c {
            '&' => "&amp;",
            '<' => "&lt;",
            '>' => "&gt;",
            '"' => "&quot;",
            '\'' => "&#39;",
            _ => continue,
        };
        write(out, &text[last..i])?;
        write(out, rep)?;
        last = i + 1;
    }
    write(out, &text[last..])
}

/// The environment shared by every render: HTML auto-escaping, chainable
/// undefined lookups, the platform filters, safe builtin tests, and no
/// global function except `can`.
fn base_env() -> Environment<'static> {
    use minijinja::{filters as f, tests as t};
    let mut env = Environment::empty();
    env.set_auto_escape_callback(|_| AutoEscape::Html);
    env.set_undefined_behavior(UndefinedBehavior::Chainable);
    env.set_formatter(format_value);
    env.add_filter("money", filters::money);
    env.add_filter("date", filters::date);
    env.add_filter("ago", filters::ago);
    env.add_filter("number", filters::number);
    env.add_filter("truncate", filters::truncate);
    env.add_filter("json", filters::json);
    env.add_filter("upper", filters::upper);
    env.add_filter("lower", filters::lower);
    env.add_filter("default", f::default);
    env.add_filter("length", f::length);
    env.add_filter("first", f::first);
    env.add_filter("last", f::last);
    env.add_filter("join", f::join);
    env.add_filter("trim", f::trim);
    env.add_filter("round", f::round);
    env.add_filter("abs", f::abs);
    env.add_filter("safe", f::safe);
    env.add_filter("escape", f::escape);
    env.add_filter("__loop", loop_guard);
    env.add_filter("__url", filters::url);
    env.add_test("defined", t::is_defined);
    env.add_test("undefined", t::is_undefined);
    env.add_test("none", t::is_none);
    env.add_test("true", t::is_true);
    env.add_test("false", t::is_false);
    env.add_test("number", t::is_number);
    env.add_test("string", t::is_string);
    env.add_test("sequence", t::is_sequence);
    env.add_test("mapping", t::is_mapping);
    env.add_test("even", t::is_even);
    env.add_test("odd", t::is_odd);
    env.add_test("divisibleby", t::is_divisibleby);
    env.add_test("eq", t::is_eq);
    env.add_test("ne", t::is_ne);
    env.add_test("lt", t::is_lt);
    env.add_test("le", t::is_le);
    env.add_test("gt", t::is_gt);
    env.add_test("ge", t::is_ge);
    env.add_test("in", t::is_in);
    env.add_test("startingwith", t::is_startingwith);
    env.add_test("endingwith", t::is_endingwith);
    env.add_function("can", can);
    env
}

/// A render failure at construction: the template id and the reason.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("template {id}: {reason}")]
pub struct BuildError {
    pub id: String,
    pub reason: String,
}

impl Renderer {
    /// Builds a renderer from `(template id, minijinja source)` pairs
    /// (`templates/<id>.jinja` of an artifact). Every `extends` and
    /// `include` target must be among them.
    pub fn new<'a>(
        sources: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Renderer, BuildError> {
        let mut base = base_env();
        let mut refs: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, source) in sources {
            base.add_template_owned(id.to_string(), source.to_string())
                .map_err(|e| BuildError {
                    id: id.to_string(),
                    reason: e.to_string(),
                })?;
            refs.insert(id.to_string(), references(source));
        }
        for (id, targets) in &refs {
            if let Some(missing) = targets.iter().find(|t| !refs.contains_key(*t)) {
                return Err(BuildError {
                    id: id.clone(),
                    reason: format!("references unknown template `{missing}`"),
                });
            }
        }
        let depth = refs
            .keys()
            .map(|id| (id.clone(), chain_depth(id, &refs, &mut Vec::new())))
            .collect();
        Ok(Renderer {
            envs: Mutex::new(HashMap::new()),
            base,
            depth,
        })
    }

    pub fn has_template(&self, id: &str) -> bool {
        self.depth.contains_key(id)
    }

    /// The longest extends/include chain from `id` (`None` if unknown).
    pub fn depth(&self, id: &str) -> Option<usize> {
        self.depth.get(id).copied()
    }

    fn env(&self, fuel: u64) -> Arc<Environment<'static>> {
        let mut envs = self.envs.lock().expect("env cache");
        envs.entry(fuel)
            .or_insert_with(|| {
                let mut env = self.base.clone();
                env.set_fuel(Some(fuel));
                Arc::new(env)
            })
            .clone()
    }

    /// Renders a page or a fragment into a string.
    pub fn render(
        &self,
        target: RenderTarget<'_>,
        data: Value,
        cx: &RenderContext,
        limits: &RenderLimits,
    ) -> Result<RenderOutput, RenderError> {
        let mut html = Vec::new();
        let stats = self.render_to(target, data, cx, limits, &mut html)?;
        Ok(RenderOutput {
            html: String::from_utf8(html).expect("minijinja writes UTF-8"),
            fuel_used: stats.fuel_used,
            ms: stats.ms,
        })
    }

    /// Renders several blocks of one template with one evaluation, one
    /// budget, and one set of limits (an action's out-of-band fragments).
    pub fn render_blocks(
        &self,
        template: &str,
        blocks: &[&str],
        data: Value,
        cx: &RenderContext,
        limits: &RenderLimits,
    ) -> Result<(Vec<String>, RenderStats), RenderError> {
        let mut parts = Vec::with_capacity(blocks.len());
        let stats = self.run(
            template,
            data,
            cx,
            limits,
            |captured, sink| {
                for block in blocks {
                    let mut buf = Vec::new();
                    captured
                        .with_state_mut(|state| state.render_block_to_write(block, &mut buf))
                        .map_err(|e| (e, Some(block.to_string())))?;
                    sink.write_all(&buf)
                        .map_err(|e| (Error::new(ErrorKind::WriteFailure, e.to_string()), None))?;
                    parts.push(String::from_utf8(buf).expect("UTF-8"));
                }
                Ok(())
            },
            &mut io::sink(),
            true,
        )?;
        Ok((parts, stats))
    }

    /// Renders into a writer as the output is produced: the streaming
    /// interface for the layout shell (`docs/08-template-engine.md`,
    /// "Streaming"; the cell buffers in F2, #161 streams).
    pub fn render_to(
        &self,
        target: RenderTarget<'_>,
        data: Value,
        cx: &RenderContext,
        limits: &RenderLimits,
        out: &mut dyn Write,
    ) -> Result<RenderStats, RenderError> {
        match target {
            RenderTarget::Page(t) => self.run(t, data, cx, limits, |_, _| Ok(()), out, false),
            RenderTarget::Fragment { template, block } => self.run(
                template,
                data,
                cx,
                limits,
                |captured, sink| {
                    captured
                        .with_state_mut(|state| state.render_block_to_write(block, sink))
                        .map_err(|e| (e, Some(block.to_string())))
                },
                out,
                true,
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run<F>(
        &self,
        template: &str,
        data: Value,
        cx: &RenderContext,
        limits: &RenderLimits,
        then: F,
        out: &mut dyn Write,
        blocks_only: bool,
    ) -> Result<RenderStats, RenderError>
    where
        F: FnOnce(
            &mut minijinja::Captured<'_>,
            &mut LimitedWriterRef<'_, '_>,
        ) -> Result<(), (Error, Option<String>)>,
    {
        let cpu = cpu_time::ThreadTime::now();
        let ms = || cpu.elapsed().as_secs_f64() * 1000.0;
        let started = Instant::now();
        let Some(depth) = self.depth(template) else {
            return Err(RenderError::NotFound(template.to_string()));
        };
        if depth > limits.max_depth {
            return Err(RenderError::Depth(RenderStats {
                fuel_used: 0,
                ms: ms(),
            }));
        }
        if !matches!(
            data.kind(),
            ValueKind::Map | ValueKind::Undefined | ValueKind::None
        ) {
            return Err(RenderError::Failed {
                message: format!("template data must be an object, got {}", data.kind()),
                stats: RenderStats {
                    fuel_used: 0,
                    ms: ms(),
                },
            });
        }
        let deadline = started + limits.timeout;
        let scope = Arc::new(Scope {
            locale: cx.locale,
            csp_nonce: cx.csp_nonce.clone(),
            csrf_token: cx.csrf_token.clone(),
            now_ms: cx.now_ms,
            utc_offset_minutes: cx.utc_offset_minutes,
            can: cx.can.clone(),
            max_iterations: limits.max_iterations,
            iterations: AtomicU64::new(0),
            deadline,
            fuel_seen: AtomicU64::new(0),
            stop: Mutex::new(None),
        });
        let root = Value::from_object(Root {
            scope: Value::from_dyn_object(scope.clone()),
            data,
        });
        let env = self.env(limits.fuel);
        let tmpl = env
            .get_template(template)
            .map_err(|_| RenderError::NotFound(template.to_string()))?;

        let mut writer = LimitedWriter {
            inner: out,
            written: 0,
            max: limits.max_output_bytes,
            deadline,
            stop: None,
        };
        let result = if blocks_only {
            // Evaluate without emitting (the page's own output is dropped),
            // then render the requested blocks into the sink.
            match tmpl.render_captured_to(root, io::sink()) {
                Ok(mut captured) => {
                    let mut sink = LimitedWriterRef(&mut writer);
                    match then(&mut captured, &mut sink) {
                        Ok(()) => Ok(captured.state().fuel_levels()),
                        Err(e) => Err(e),
                    }
                }
                Err(e) => Err((e, None)),
            }
        } else {
            match tmpl.render_captured_to(root, &mut writer) {
                Ok(captured) => Ok(captured.state().fuel_levels()),
                Err(e) => Err((e, None)),
            }
        };
        let fuel_seen = scope.fuel_seen.load(Ordering::Relaxed);
        let stats_at = |fuel: u64| RenderStats {
            fuel_used: fuel,
            ms: ms(),
        };
        match result {
            Ok(levels) => Ok(stats_at(levels.map_or(0, |(c, _)| c))),
            Err((e, block)) => {
                let stop = *scope.stop.lock().expect("stop lock");
                let stop = stop.or(writer.stop);
                Err(match (e.kind(), stop) {
                    (ErrorKind::OutOfFuel, _) => RenderError::Fuel(stats_at(limits.fuel)),
                    (_, Some(Stop::Iterations)) => RenderError::Iterations(stats_at(fuel_seen)),
                    (_, Some(Stop::OutputSize)) => RenderError::OutputSize(stats_at(fuel_seen)),
                    (_, Some(Stop::Timeout)) => RenderError::Timeout(stats_at(fuel_seen)),
                    (ErrorKind::UnknownBlock, _) => {
                        RenderError::NotFound(format!("{template}#{}", block.unwrap_or_default()))
                    }
                    _ => RenderError::Failed {
                        message: describe(&e),
                        stats: stats_at(fuel_seen),
                    },
                })
            }
        }
    }
}

/// The writer handed to block rendering (a named type so the closure
/// signature stays readable).
pub struct LimitedWriterRef<'a, 'w>(&'a mut LimitedWriter<'w>);

impl Write for LimitedWriterRef<'_, '_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

/// One line for the tenant log: the error and where it happened.
fn describe(e: &Error) -> String {
    let mut s = e.to_string();
    if let (Some(name), Some(line)) = (e.name(), e.line()) {
        s = format!("{name}:{line}: {s}");
    }
    s
}

fn chain_depth(id: &str, refs: &BTreeMap<String, Vec<String>>, path: &mut Vec<String>) -> usize {
    if path.iter().any(|p| p == id) {
        return usize::MAX;
    }
    path.push(id.to_string());
    let mut deepest = 0usize;
    for t in refs.get(id).map(Vec::as_slice).unwrap_or(&[]) {
        let d = chain_depth(t, refs, path).saturating_add(1);
        deepest = deepest.max(d);
    }
    path.pop();
    deepest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_tags() {
        assert_eq!(Locale::parse("en-AE"), Locale::EN_AE);
        assert_eq!(Locale::parse("ar-AE"), Locale::AR_AE);
        assert_eq!(
            Locale::parse("ar-AE-u-nu-arab"),
            Locale::AR_AE_ARABIC_DIGITS
        );
        assert_eq!(Locale::parse("fr"), Locale::EN_AE);
    }

    #[test]
    fn reference_scan() {
        assert_eq!(
            references(r#"{% extends "pages/_layouts/main" %}x{% include "partials/a" %}"#),
            vec!["pages/_layouts/main".to_string(), "partials/a".to_string()]
        );
    }
}
