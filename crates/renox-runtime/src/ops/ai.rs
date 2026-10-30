//! `ctx.ai` (`docs/contracts/ops.md` 1.7.0 section 23; #322).
//!
//! | Mode | Where the call goes | Who holds the key |
//! | --- | --- | --- |
//! | `direct` | the provider's host through `fetch` (the app's allowlist, blocked ranges) | the app: its secret `AI_<PROVIDER>_KEY` |
//! | `gateway` | the cell's [`AiGateway`] (the control plane's `POST /v1/ai/chat`, #327) | the platform; the isolate never sees it |
//!
//! The loop with local tools runs in the bootstrap, in the request, under
//! the watchdog; these ops give it the mode, the gateway, and the meter.
//! Requests and answers are never logged.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// `max_tokens` at most (*proposed*, ops.md section 23).
pub const MAX_TOKENS: u32 = 8192;
/// Rounds of local tool calls in one `ai.chat`.
pub const MAX_TOOL_ROUNDS: u32 = 8;
/// The direct provider's base URL.
pub const ANTHROPIC_BASE: &str = "https://api.anthropic.com";

/// Why the gateway did not answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayError {
    /// The tenant's monthly tokens are used up (`RENOX_AI_QUOTA`).
    Quota,
    /// No gateway, or it or every provider failed (`RENOX_AI_UNAVAILABLE`).
    Unavailable(String),
    /// The request was refused as invalid.
    Invalid(String),
}

/// The platform's AI gateway as the cell reaches it.
pub trait AiGateway: Send + Sync {
    /// `body` is the deploy API's `AiChatRequest` JSON; the answer its `AiChatResult`.
    fn chat(
        &self,
        body: String,
    ) -> Pin<Box<dyn Future<Output = Result<String, GatewayError>> + Send>>;
}

/// What the cell gives an [`crate::IsolateSpec`].
#[derive(Clone)]
pub struct AiSlot(pub Arc<dyn AiGateway>);

impl std::fmt::Debug for AiSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AiSlot")
    }
}

/// The mode of one deployment: `[ai] mode`, else `direct` when the app
/// declares an `AI_<PROVIDER>_KEY` secret, else `gateway`.
pub fn mode_of(
    manifest_ai: Option<&serde_json::Value>,
    app_secrets: &[String],
) -> (&'static str, Option<String>) {
    let key = app_secrets
        .iter()
        .find(|n| n.starts_with("AI_") && n.ends_with("_KEY") && n.len() > 7)
        .cloned();
    let declared = manifest_ai
        .and_then(|a| a.get("mode"))
        .and_then(|m| m.as_str());
    match declared {
        Some("direct") => ("direct", key),
        Some("gateway") => ("gateway", None),
        _ if key.is_some() => ("direct", key),
        _ => ("gateway", None),
    }
}

/// What the ops of one isolate use.
pub struct AiEnv {
    pub mode: &'static str,
    /// The direct mode's key secret (`AI_ANTHROPIC_KEY`).
    pub key_name: Option<String>,
    pub base: String,
    pub app: String,
    pub tenant_id: String,
    pub gateway: Option<Arc<dyn AiGateway>>,
}

#[cfg(feature = "v8")]
pub(crate) use ops::*;

#[cfg(feature = "v8")]
mod ops {
    use std::cell::RefCell;
    use std::rc::Rc;

    use deno_core::{OpState, op2};
    use deno_error::JsErrorBox;
    use serde::Serialize;

    use super::*;
    use crate::ops::request::{live_request, op_error};

    #[derive(Serialize)]
    pub(crate) struct Env {
        mode: &'static str,
        key_name: Option<String>,
        base: String,
        max_tokens: u32,
        max_rounds: u32,
    }

    #[op2]
    #[serde]
    pub(crate) fn op_ai_env(state: &mut OpState) -> Env {
        let env = state.borrow::<Rc<AiEnv>>();
        Env {
            mode: env.mode,
            key_name: env.key_name.clone(),
            base: env.base.clone(),
            max_tokens: MAX_TOKENS,
            max_rounds: MAX_TOOL_ROUNDS,
        }
    }

    /// The gateway mode's call: `body` is `{ model, system, messages, tools, max_tokens }`.
    #[op2]
    #[string]
    pub(crate) async fn op_ai_gateway(
        state: Rc<RefCell<OpState>>,
        token: u32,
        #[string] body: String,
    ) -> Result<String, JsErrorBox> {
        let request = live_request(&state.borrow(), token)?;
        let env = state.borrow().borrow::<Rc<AiEnv>>().clone();
        let Some(gateway) = env.gateway.clone() else {
            return Err(op_error(
                "RENOX_AI_UNAVAILABLE",
                serde_json::json!({ "reason": "no_gateway" }),
                "The AI gateway is not available on this node.",
            ));
        };
        let mut req: serde_json::Value = serde_json::from_str(&body)
            .map_err(|_| JsErrorBox::type_error("ai.chat: the request is not JSON"))?;
        if let Some(o) = req.as_object_mut() {
            o.insert("tenant_id".into(), env.tenant_id.clone().into());
            o.insert("app".into(), env.app.clone().into());
            o.insert(
                "request_id".into(),
                request.borrow().request_id.clone().into(),
            );
        }
        let cancel = request.borrow().cancel.clone();
        let call = gateway.chat(req.to_string());
        let result = {
            use deno_core::CancelFuture;
            call.or_cancel(cancel).await
        };
        match result {
            Err(_) => Err(op_error(
                "RENOX_DEADLINE",
                serde_json::Value::Null,
                "The request deadline passed.",
            )),
            Ok(Ok(json)) => Ok(json),
            Ok(Err(GatewayError::Quota)) => Err(op_error(
                "RENOX_AI_QUOTA",
                serde_json::Value::Null,
                "The monthly AI quota is used up.",
            )),
            Ok(Err(GatewayError::Invalid(m))) => {
                Err(JsErrorBox::type_error(format!("ai.chat: {m}")))
            }
            Ok(Err(GatewayError::Unavailable(m))) => {
                tracing::warn!(reason = %m, "ai gateway unavailable");
                Err(op_error(
                    "RENOX_AI_UNAVAILABLE",
                    serde_json::Value::Null,
                    "The AI provider is unavailable.",
                ))
            }
        }
    }

    /// Tokens of one model call, onto the request's meter record.
    #[op2(fast)]
    pub(crate) fn op_ai_meter(
        state: &mut OpState,
        token: u32,
        tokens_in: u32,
        tokens_out: u32,
    ) -> Result<(), JsErrorBox> {
        let request = live_request(state, token)?;
        let mut r = request.borrow_mut();
        r.ai_tokens_in += u64::from(tokens_in);
        r.ai_tokens_out += u64::from(tokens_out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_follows_the_manifest_then_the_key() {
        let key = vec!["AI_ANTHROPIC_KEY".to_string()];
        assert_eq!(mode_of(None, &[]), ("gateway", None));
        assert_eq!(
            mode_of(None, &key),
            ("direct", Some("AI_ANTHROPIC_KEY".into()))
        );
        let gw = serde_json::json!({ "mode": "gateway" });
        assert_eq!(mode_of(Some(&gw), &key), ("gateway", None));
    }
}
