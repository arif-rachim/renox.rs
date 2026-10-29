//! The operator health listener of a controlled worker (gate F1 notes on
//! #55): `GET /healthz` on `[control] health_listen` answers
//! `{ "status": "ok" }` or `{ "status": "degraded", "reasons": [...] }`
//! (#98), always 200 while the gateway serves; anything else is 404. Bind
//! it to a private address: it names no tenant, but it is not for the
//! public.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http::{Request, Response, StatusCode, header};
use http_body_util::Full;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// Why the node is degraded, by component. Empty: healthy.
#[derive(Default)]
pub struct Health {
    reasons: Mutex<BTreeMap<&'static str, String>>,
}

impl Health {
    /// Marks `component` degraded with `reason` (no secret, no tenant data).
    /// Logged once per change.
    pub fn degrade(&self, component: &'static str, reason: impl Into<String>) {
        let reason = reason.into();
        let mut r = self.reasons.lock().expect("health lock");
        if r.get(component) != Some(&reason) {
            tracing::warn!(component, %reason, "worker degraded");
            r.insert(component, reason);
        }
    }

    /// Clears `component`.
    pub fn recover(&self, component: &'static str) {
        if self
            .reasons
            .lock()
            .expect("health lock")
            .remove(component)
            .is_some()
        {
            tracing::info!(component, "worker recovered");
        }
    }

    /// Whether `component` is degraded now.
    pub fn has(&self, component: &str) -> bool {
        self.reasons
            .lock()
            .expect("health lock")
            .contains_key(component)
    }

    pub fn is_degraded(&self) -> bool {
        !self.reasons.lock().expect("health lock").is_empty()
    }

    /// `component: reason` lines, sorted.
    pub fn reasons(&self) -> Vec<String> {
        self.reasons
            .lock()
            .expect("health lock")
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect()
    }

    pub fn body(&self) -> serde_json::Value {
        let reasons = self.reasons();
        if reasons.is_empty() {
            json!({ "status": "ok" })
        } else {
            json!({ "status": "degraded", "reasons": reasons })
        }
    }
}

fn respond(health: &Health, req: &Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    if req.uri().path() != "/healthz" || req.method() != http::Method::GET {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Full::new(Bytes::new()))
            .expect("valid response");
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Full::new(Bytes::from(health.body().to_string())))
        .expect("valid response")
}

/// Binds `addr` and serves `/healthz`. Returns the bound address and the task.
pub async fn serve(
    addr: SocketAddr,
    health: Arc<Health>,
) -> std::io::Result<(SocketAddr, JoinHandle<()>)> {
    let listener = TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            };
            let health = health.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req| {
                    let health = health.clone();
                    async move { Ok::<_, std::convert::Infallible>(respond(&health, &req)) }
                });
                let conn = hyper::server::conn::http1::Builder::new()
                    .keep_alive(false)
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service);
                let _ = tokio::time::timeout(Duration::from_secs(10), conn).await;
            });
        }
    });
    Ok((local, task))
}
