//! Issue #577: `ctx.render` (`docs/contracts/ops.md` 1.8.0 section 25, the
//! module argument of 1.9.0). V8-linked; the host is a fake that echoes the
//! template id the op resolved, so the prefix rule is visible.
#![cfg(feature = "v8")]

mod support;

use std::sync::Arc;

use renox_runtime::ops::pdf::{TemplateError, TemplateHost, TemplateSlot};
use renox_runtime::{Runtime, RuntimeConfig};
use support::{body_json, ctx, get, spec, write_artifact};

/// Answers `<i>id|locale|dir|data</i>`; ids ending `missing` are unknown and
/// ids ending `limit` hit the fuel limit.
struct Echo;

impl TemplateHost for Echo {
    fn render(&self, template: &str, data_json: &str) -> Result<String, String> {
        Ok(format!("{template}|{data_json}"))
    }

    fn render_fragment(
        &self,
        template: &str,
        data_json: &str,
        locale: &str,
        dir: &str,
        _principal: Option<std::sync::Arc<renox_authz::Principal>>,
    ) -> Result<(String, u64, f64), TemplateError> {
        if template.ends_with("missing") {
            return Err(TemplateError::Unknown);
        }
        if template.ends_with("limit") {
            return Err(TemplateError::Limit("fuel"));
        }
        Ok((
            format!("<i>{template}|{locale}|{dir}|{data_json}</i>"),
            7,
            1.5,
        ))
    }
}

const APP: &str = r#"
import { tax } from "renox:modules";
const attempt = async (f) => { try { return { ok: await f() }; } catch (e) { return { name: e.name, code: e.code ?? null, message: e.message, details: e.details ?? null }; } };
export async function GET(ctx) {
  switch (ctx.url.searchParams.get("case")) {
    case "app":
      return Response.json({ html: await ctx.render("partials/row", { n: 1, big: 2n }) });
    case "module":
      return Response.json(await tax.show());
    case "missing":
      return Response.json(await attempt(() => ctx.render("partials/missing", {})));
    case "limit":
      return Response.json(await attempt(() => ctx.render("partials/limit", {})));
    case "escape":
      return Response.json({
        dots: await attempt(() => ctx.render("../x", {})),
        mid: await attempt(() => ctx.render("a/../x", {})),
        slash: await attempt(() => ctx.render("/partials/row", {})),
      });
    default:
      return new Response("unknown", { status: 400 });
  }
}
"#;

const TAX: &str = r#"
const attempt = async (f) => { try { return { ok: await f() }; } catch (e) { return { name: e.name, message: e.message }; } };
export async function show(ctx) {
  return {
    own: await ctx.render("partials/invoice", { a: 1 }),
    already: await ctx.render("modules/tax/partials/invoice", {}),
    other: await ctx.render("modules/other/partials/invoice", {}),
    escape: await attempt(() => ctx.render("../partials/row", {})),
    pdf: await attempt(() => ctx.pdf.render("../partials/row", {})),
  };
}
"#;

fn artifact() -> (std::path::PathBuf, String) {
    let perms = serde_json::json!({ "tables": "tax__*", "network": [], "secrets": [], "slots": [], "hooks": [] });
    let manifest = serde_json::json!({
        "artifact": { "version": 1 },
        "app": { "name": "render", "timezone": "Asia/Dubai" },
        "code": { "format": "esm-dir", "entry": {
            "functions/f": "functions/f.js",
            "modules/tax/services": "modules/tax/services.js",
        } },
        "routes": [{ "kind": "function", "method": "GET", "path": "/", "module": "functions/f", "export": "GET" }],
        "permissions": { "network": [], "secrets": [] },
        "modules": [{
            "name": "tax", "version": "1.0.0", "hash": "0".repeat(64), "source": "path:modules/tax",
            "mount": "/tax", "isolation": "shared", "dependencies": [], "config": {},
            "permissions": perms, "approved": perms,
            "exports": { "services": ["show"] },
        }],
    });
    let m = serde_json::to_vec(&manifest).unwrap();
    write_artifact(&[
        ("manifest.json", &m),
        ("code/functions/f.js", APP.as_bytes()),
        ("code/modules/tax/services.js", TAX.as_bytes()),
    ])
}

async fn call(
    case: &str,
    id: &str,
) -> (serde_json::Value, renox_runtime::isolate::InvocationMeter) {
    let rt = Runtime::new(RuntimeConfig::default());
    let (dir, hash) = artifact();
    let mut s = spec(&dir, &hash, renox_runtime::limits::Limits::FREE);
    s.templates = Some(TemplateSlot(Arc::new(Echo)));
    let iso = rt.create_isolate(s).await.unwrap();
    let out = iso.dispatch(ctx(id), get(&format!("/?case={case}"))).await;
    (body_json(&out.response), out.meter)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ctx_render_returns_the_fragment_and_meters_render_ms() {
    let (v, meter) = call("app", "req_render_app_000001").await;
    // No page: the host gets no locale and no direction. Data is JSON, a
    // bigint a decimal string.
    assert_eq!(
        v["html"], r#"<i>partials/row|||{"n":1,"big":"2"}</i>"#,
        "{v}"
    );
    assert_eq!(meter.render_fuel, 7);
    assert!(meter.render_ms >= 1.5, "{}", meter.render_ms);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_module_template_id_is_prefixed_for_render_and_pdf() {
    let (v, _) = call("module", "req_render_mod_000001").await;
    assert_eq!(
        v["own"], r#"<i>modules/tax/partials/invoice|||{"a":1}</i>"#,
        "{v}"
    );
    // The caller's own prefix is kept, never doubled.
    assert_eq!(
        v["already"], "<i>modules/tax/partials/invoice|||{}</i>",
        "{v}"
    );
    // Another module's tree is only reachable through the caller's prefix.
    assert_eq!(
        v["other"], "<i>modules/tax/modules/other/partials/invoice|||{}</i>",
        "{v}"
    );
    assert_eq!(v["escape"]["name"], "TypeError", "{v}");
    assert_eq!(v["pdf"]["name"], "TypeError", "{v}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_template_is_a_type_error_naming_it() {
    let (v, _) = call("missing", "req_render_unk_000001").await;
    assert_eq!(v["name"], "TypeError", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("partials/missing"),
        "{v}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_render_limit_is_raised_to_the_caller() {
    let (v, _) = call("limit", "req_render_lim_000001").await;
    assert_eq!(v["code"], "RENOX_RENDER_LIMIT", "{v}");
    assert_eq!(v["details"]["limit"], "fuel", "{v}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dot_dot_and_a_leading_slash_are_refused() {
    let (v, meter) = call("escape", "req_render_esc_000001").await;
    for k in ["dots", "mid", "slash"] {
        assert_eq!(v[k]["name"], "TypeError", "{k}: {v}");
    }
    assert_eq!(meter.render_fuel, 0, "nothing was rendered");
}
