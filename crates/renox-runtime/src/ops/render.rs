//! `op_render_template(token, template, dataJson, module, locale, dir)`: a
//! template of the caller as an HTML fragment (`ops.md` 1.8.0 section 25;
//! the module argument from 1.9.0). The id rule is shared with
//! `op_render_pdf` (section 24) and the realtime `fragment` payload.

/// `partials/chat-message.html` of module `chat` is the template id
/// `modules/chat/partials/chat-message`; the app's has no prefix. An id that
/// already starts with the module's own prefix is kept.
pub fn partial_id(fragment: &str, module: &str) -> String {
    let f = fragment.strip_suffix(".html").unwrap_or(fragment);
    let f = f.trim_start_matches('/');
    if module == "app" || module.is_empty() {
        f.to_string()
    } else {
        let prefix = format!("modules/{module}/");
        if f.starts_with(&prefix) {
            f.to_string()
        } else {
            format!("{prefix}{f}")
        }
    }
}

/// The deployment's template id for a caller's `template` (`ops.md` section
/// 24): `..` segments and a leading `/` are refused; a module's id gets the
/// prefix `modules/<name>/`. `module` is `None` or empty for the app.
pub fn template_id(template: &str, module: Option<&str>) -> Result<String, String> {
    if template.is_empty() || template.starts_with('/') || template.split('/').any(|s| s == "..") {
        return Err(format!("`{template}` is not a template id"));
    }
    Ok(partial_id(template, module.unwrap_or("")))
}

#[cfg(feature = "v8")]
pub(crate) use ops::*;

#[cfg(feature = "v8")]
mod ops {
    use std::cell::RefCell;
    use std::rc::Rc;

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;

    use super::template_id;
    use crate::ops::pdf::{TemplateEnv, TemplateError};
    use crate::ops::request::{live_request, op_error};

    /// `ctx.render(template, data)`: the fragment's HTML. The render counts
    /// as `render_fuel` and `render_ms` of the request. `locale` and `dir`
    /// are the request's `setLocale` values (empty: none), added by the
    /// bootstrap beside `module`.
    #[op2]
    #[string]
    pub(crate) async fn op_render_template(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] template: String,
        #[string] data_json: String,
        #[string] module: Option<String>,
        #[string] locale: Option<String>,
        #[string] dir: Option<String>,
    ) -> Result<String, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let id = template_id(&template, module.as_deref())
            .map_err(|m| JsErrorBox::type_error(format!("render: {m}")))?;
        let host = state.borrow().borrow::<Rc<TemplateEnv>>().templates.clone();
        let Some(host) = host else {
            return Err(JsErrorBox::type_error(format!(
                "render: unknown template `{id}`"
            )));
        };
        let (locale, dir) = (locale.unwrap_or_default(), dir.unwrap_or_default());
        let host_id = id.clone();
        let out = tokio::task::spawn_blocking(move || {
            host.render_fragment(&host_id, &data_json, &locale, &dir)
        })
        .await
        .map_err(|_| {
            op_error(
                "RENOX_INTERNAL",
                serde_json::Value::Null,
                "The render failed.",
            )
        })?;
        match out {
            Ok((html, fuel, ms)) => {
                let mut r = request.borrow_mut();
                r.render_fuel += fuel;
                r.render_ms += ms;
                Ok(html)
            }
            Err(TemplateError::Unknown) => Err(JsErrorBox::type_error(format!(
                "render: unknown template `{id}`"
            ))),
            Err(TemplateError::Limit(limit)) => Err(op_error(
                "RENOX_RENDER_LIMIT",
                serde_json::json!({ "limit": limit }),
                "The template hit a render limit.",
            )),
            Err(TemplateError::Failed(m)) => {
                tracing::warn!(error = %m, template = %id, "ctx.render failed");
                Err(op_error(
                    "RENOX_INTERNAL",
                    serde_json::json!({ "reason": "render" }),
                    "The render failed.",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_ids() {
        assert_eq!(
            partial_id("partials/chat-message.html", "app"),
            "partials/chat-message"
        );
        assert_eq!(
            partial_id("partials/item", "chat"),
            "modules/chat/partials/item"
        );
        assert_eq!(
            partial_id("modules/chat/partials/item", "chat"),
            "modules/chat/partials/item"
        );
    }

    #[test]
    fn template_ids_are_checked_then_prefixed() {
        assert_eq!(template_id("partials/x", None).unwrap(), "partials/x");
        assert_eq!(
            template_id("partials/x", Some("tax")).unwrap(),
            "modules/tax/partials/x"
        );
        assert!(template_id("../x", None).is_err());
        assert!(template_id("a/../x", Some("tax")).is_err());
        assert!(template_id("/x", None).is_err());
        assert!(template_id("", None).is_err());
    }
}
